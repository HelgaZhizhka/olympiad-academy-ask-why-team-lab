import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASK_WHY_POST_COMPLETION_PROMPT_V5,
  ASK_WHY_PROMPT_VERSION,
} from './prompts/ask-why.post-completion.v5.mjs';

const DEFAULT_MODEL = 'google/gemma-4-26b-a4b-it';
const FALLBACK_REPLY =
  "Uzr, hozir qisqa tushuntirish bera olmadim. Savolni masaladagi aniq bir qadam haqida boshqacha qilib yozib ko'ring.";
const MAX_REQUESTS_PER_HOUR = 30;
const SESSION_COOKIE = 'lab_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 10_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const distDirectory = path.join(here, 'dist');
// Without SESSION_SECRET, sessions simply do not survive a server restart.
const sessionSecret = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const requestLog = new Map();

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function safeEqual(a, b) {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function sign(value) {
  return createHmac('sha256', sessionSecret).update(value).digest('base64url');
}

function createSessionCookie(email) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + SESSION_TTL_MS })).toString(
    'base64url',
  );
  const value = `${payload}.${sign(payload)}`;
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function readSession(request) {
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(request.headers.cookie ?? '');
  if (!match) return null;
  const [payload, signature] = match[1].split('.');
  if (!payload || !signature || !safeEqual(sign(payload), signature)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof session.email === 'string' && session.exp > Date.now() ? session : null;
  } catch {
    return null;
  }
}

function tasks() {
  const raw = process.env.ASK_WHY_LAB_TASKS_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((task) =>
          typeof task?.id === 'string' && typeof task?.label === 'string' &&
          typeof task?.statement === 'string' && typeof task?.correctAnswer === 'string' &&
          Array.isArray(task?.solutionSteps),
        )
      : [];
  } catch { return []; }
}

function canMakeRequest(email) {
  const now = Date.now();
  const since = now - 60 * 60 * 1000;
  const recent = (requestLog.get(email) ?? []).filter((time) => time > since);
  if (recent.length >= MAX_REQUESTS_PER_HOUR) return false;
  recent.push(now);
  requestLog.set(email, recent);
  return true;
}

function hasCyrillic(value) { return /[\u0400-\u04ff]/u.test(value); }
function sentenceCount(value) {
  const endings = value.match(/(?<!\d)[.!?]+(?!\d)/gu);
  return endings === null ? (value.trim() ? 1 : 0) : endings.length;
}
function isSafeReply(value) { return value.trim() && !hasCyrillic(value) && sentenceCount(value) <= 2; }
function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}
function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}
function publicTask(task) { return { id: task.id, label: task.label, statement: task.statement }; }
function configuredModel() {
  const value = (process.env.ASK_WHY_LAB_MODEL?.trim() || DEFAULT_MODEL).replace(/:free$/u, '');
  return value.includes('/') ? value : `google/${value}`;
}

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('Body too large.')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString()));
    request.on('error', reject);
  });
}

async function handleLogin(request, response) {
  const teamCode = process.env.TEAM_ACCESS_CODE;
  if (!teamCode) return sendJson(response, 503, { error: 'The team access code is not configured.' });
  let input;
  try { input = JSON.parse(await readBody(request)); } catch { return sendJson(response, 400, { error: 'Invalid request body.' }); }
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
  const code = typeof input?.code === 'string' ? input.code : '';
  if (!isValidEmail(email) || !code || !safeEqual(code, teamCode)) {
    return sendJson(response, 401, { error: 'Could not sign in. Check the email and the team access code.' });
  }
  sendJson(response, 200, { email }, { 'Set-Cookie': createSessionCookie(email) });
}

async function handleAskWhy(request, response, session) {
  const taskList = tasks();
  if (taskList.length === 0) return sendJson(response, 503, { error: 'The lab task context is not configured.' });

  if (request.method === 'GET') {
    return sendJson(response, 200, {
      email: session.email,
      tasks: taskList.map(publicTask),
      configuration: {
        gateway: 'OpenRouter',
        model: configuredModel(),
        route: 'paid',
      },
    });
  }
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
  if (!canMakeRequest(session.email)) {
    return sendJson(response, 429, { error: 'Request limit reached. Please try again later.' });
  }

  let input;
  try { input = JSON.parse(await readBody(request)); } catch { return sendJson(response, 400, { error: 'Invalid request body.' }); }
  const task = taskList.find((candidate) => candidate.id === input?.taskId);
  const question = typeof input?.question === 'string' ? input.question.trim() : '';
  const completionState = input?.completionState;
  if (!task) return sendJson(response, 400, { error: 'Choose a configured task.' });
  if (!question || question.length > 500) return sendJson(response, 400, { error: 'Question must be 1–500 characters.' });
  if (!['after_correct_answer', 'after_full_walkthrough'].includes(completionState)) {
    return sendJson(response, 400, { error: 'Choose a valid learner state.' });
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    return sendJson(response, 503, { error: 'The OpenRouter model configuration is missing.' });
  }
  // The lab intentionally tests the paid OpenRouter route. A leftover `:free`
  // suffix is stripped so the deployment cannot silently test a different
  // availability tier than the one shown to reviewers.
  const model = configuredModel();
  const context = {
    product_state: completionState,
    task: {
      id: task.id,
      statement: task.statement,
      protected_canonical_answer: task.correctAnswer,
      ...(completionState === 'after_full_walkthrough'
        ? { full_walkthrough: task.solutionSteps }
        : { accepted_learner_answer: task.correctAnswer }),
    },
    requested_language: 'uz-Latn',
  };
  const systemContent = `${ASK_WHY_POST_COMPLETION_PROMPT_V5}\n\nPrompt version: ${ASK_WHY_PROMPT_VERSION}\n\nCurrent server-side context:\n${JSON.stringify(context)}`;

  const startedAt = performance.now();
  let result;
  try {
    result = await callOpenRouter(openRouterKey, model, systemContent, question);
  } catch (error) {
    console.info('ask-why provider failed', {
      user: session.email,
      provider: 'openrouter',
      model,
      reason: error instanceof Error ? error.message : 'unknown_error',
    });
    return sendJson(response, 200, {
      reply: FALLBACK_REPLY,
      status: 'fallback',
      provider: 'openrouter',
      model,
      latency_ms: Math.round(performance.now() - startedAt),
    });
  }
  const latencyMs = Math.round(performance.now() - startedAt);
  if (!isSafeReply(result.reply)) {
    console.info('ask-why fallback', {
      user: session.email,
      provider: 'openrouter',
      upstream_provider: result.upstreamProvider,
      model,
      reason: 'response_validation_failed',
    });
    return sendJson(response, 200, {
      reply: FALLBACK_REPLY,
      status: 'fallback',
      provider: 'openrouter',
      upstream_provider: result.upstreamProvider,
      model,
      latency_ms: latencyMs,
      usage: result.usage,
    });
  }
  return sendJson(response, 200, {
    reply: result.reply.trim(),
    status: 'ok',
    provider: 'openrouter',
    upstream_provider: result.upstreamProvider,
    model,
    latency_ms: latencyMs,
    usage: result.usage,
  });
}

async function fetchWithTimeout(url, options, timeoutMs = 30_000) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: abort.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenRouter(apiKey, model, systemContent, question) {
  const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: question },
      ],
      temperature: 0,
      max_tokens: 300,
      provider: { data_collection: 'deny', allow_fallbacks: true },
    }),
  });
  if (!response.ok) throw new Error(`openrouter_http_${response.status}`);
  const payload = await response.json();
  const reply = payload?.choices?.[0]?.message?.content;
  if (typeof reply !== 'string' || !reply) throw new Error('openrouter_empty_reply');
  return {
    reply,
    upstreamProvider: typeof payload?.provider === 'string' ? payload.provider : undefined,
    usage: {
      input_tokens: Number.isFinite(payload?.usage?.prompt_tokens) ? payload.usage.prompt_tokens : undefined,
      output_tokens: Number.isFinite(payload?.usage?.completion_tokens) ? payload.usage.completion_tokens : undefined,
      cost_usd: Number.isFinite(payload?.usage?.cost) ? payload.usage.cost : undefined,
    },
  };
}

async function serveStatic(request, response) {
  const requestPath = new URL(request.url, 'http://localhost').pathname;
  const resolved = path.normalize(path.join(distDirectory, requestPath));
  if (!resolved.startsWith(distDirectory)) {
    return sendJson(response, 404, { error: 'Not found.' });
  }
  const candidates = requestPath === '/' ? [path.join(distDirectory, 'index.html')] : [resolved, path.join(distDirectory, 'index.html')];
  for (const candidate of candidates) {
    try {
      const file = await readFile(candidate);
      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(candidate)] ?? 'application/octet-stream',
        'X-Robots-Tag': 'noindex, nofollow',
        'Cache-Control': candidate.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      return response.end(file);
    } catch { /* try the next candidate */ }
  }
  sendJson(response, 404, { error: 'Not found.' });
}

const server = createServer(async (request, response) => {
  try {
    const { pathname } = new URL(request.url, 'http://localhost');
    if (request.method === 'POST' && !sameOrigin(request)) {
      return sendJson(response, 403, { error: 'Cross-site request blocked.' });
    }
    if (pathname === '/api/session' && request.method === 'POST') return await handleLogin(request, response);
    if (pathname === '/api/logout' && request.method === 'POST') {
      return sendJson(response, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
    }
    if (pathname === '/api/ask-why-lab') {
      const session = readSession(request);
      if (!session) return sendJson(response, 401, { error: 'Sign in with your email and the team access code first.' });
      return await handleAskWhy(request, response, session);
    }
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
    return await serveStatic(request, response);
  } catch (error) {
    console.error('unhandled server error', error);
    sendJson(response, 500, { error: 'Internal server error.' });
  }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log(`Ask Why Team Lab listening on port ${port}`));
