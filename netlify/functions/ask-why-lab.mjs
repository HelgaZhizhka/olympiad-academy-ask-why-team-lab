import { getUser } from '@netlify/identity';
import {
  ASK_WHY_POST_COMPLETION_PROMPT_V5,
  ASK_WHY_PROMPT_VERSION,
} from '../../prompts/ask-why.post-completion.v5.mjs';

const DEFAULT_MODEL = 'google/gemma-4-26b-a4b-it:free';
const FALLBACK_REPLY =
  "Uzr, hozir qisqa tushuntirish bera olmadim. Savolni masaladagi aniq bir qadam haqida boshqacha qilib yozib ko'ring.";
const MAX_REQUESTS_PER_HOUR = 30;
const requestLog = new Map();

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
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
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  return origin === null || origin === new URL(request.url).origin;
}
function publicTask(task) { return { id: task.id, label: task.label, statement: task.statement }; }

export default async (request) => {
  const user = await getUser();
  if (!user?.email) return json(401, { error: 'Sign in with an invited team account first.' });
  const taskList = tasks();
  if (taskList.length === 0) return json(503, { error: 'The lab task context is not configured.' });

  if (request.method === 'GET') return json(200, { tasks: taskList.map(publicTask) });
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  if (!sameOrigin(request)) return json(403, { error: 'Cross-site request blocked.' });
  if (!canMakeRequest(user.email)) return json(429, { error: 'Request limit reached. Please try again later.' });

  let input;
  try { input = await request.json(); } catch { return json(400, { error: 'Invalid request body.' }); }
  const task = taskList.find((candidate) => candidate.id === input?.taskId);
  const question = typeof input?.question === 'string' ? input.question.trim() : '';
  const completionState = input?.completionState;
  if (!task) return json(400, { error: 'Choose a configured task.' });
  if (!question || question.length > 500) return json(400, { error: 'Question must be 1–500 characters.' });
  if (!['after_correct_answer', 'after_full_walkthrough'].includes(completionState)) {
    return json(400, { error: 'Choose a valid learner state.' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return json(503, { error: 'The private model configuration is missing.' });
  const model = process.env.ASK_WHY_LAB_MODEL?.trim() || DEFAULT_MODEL;
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

  try {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 30_000);
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: abort.signal,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: `${ASK_WHY_POST_COMPLETION_PROMPT_V5}\n\nPrompt version: ${ASK_WHY_PROMPT_VERSION}\n\nCurrent server-side context:\n${JSON.stringify(context)}`,
          },
          { role: 'user', content: question },
        ],
        temperature: 0,
        max_tokens: 300,
        reasoning: { effort: 'none' },
        provider: { data_collection: 'deny', allow_fallbacks: false },
      }),
    });
    clearTimeout(timeout);
    if (!response.ok) {
      console.info('ask-why fallback', { user: user.email, reason: 'provider_error', status: response.status });
      return json(200, { reply: FALLBACK_REPLY, status: 'fallback' });
    }
    const payload = await response.json();
    const reply = payload?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !isSafeReply(reply)) {
      console.info('ask-why fallback', { user: user.email, reason: 'response_validation_failed' });
      return json(200, { reply: FALLBACK_REPLY, status: 'fallback' });
    }
    return json(200, { reply: reply.trim(), status: 'ok' });
  } catch (error) {
    console.info('ask-why fallback', { user: user.email, reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_error' });
    return json(200, { reply: FALLBACK_REPLY, status: 'fallback' });
  }
};
