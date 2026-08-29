import './style.css';

const app = document.querySelector('#app');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function request(path, options) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error ?? 'Request failed.');
    error.status = response.status;
    throw error;
  }
  return body;
}

function showLogin(error = '') {
  app.innerHTML = `
    <section class="card intro">
      <p class="eyebrow">Olympiad Academy · Internal</p>
      <h1>Ask Why Lab</h1>
      <p>Review the current Uzbek Ask Why model on teacher-approved tasks. This is not a child-facing product or a general chat.</p>
    </section>
    <section class="card narrow">
      <h2>Team sign in</h2>
      <p class="muted">Access is limited to the team. Use your work email and the shared team access code.</p>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      <form id="login-form">
        <label>Email <input id="email" type="email" autocomplete="email" required /></label>
        <label>Team access code <input id="code" type="password" autocomplete="current-password" required /></label>
        <button type="submit">Sign in</button>
      </form>
    </section>`;

  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = document.querySelector('#email').value.trim();
    const code = document.querySelector('#code').value;
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      await request('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      await showLab();
    } catch {
      showLogin('Could not sign in. Check the email and the team access code.');
    }
  });
}

function formatTelemetry(data) {
  const route = data.upstream_provider
    ? `OpenRouter → ${data.upstream_provider}`
    : 'OpenRouter';
  const model = data.model ?? 'unknown model';
  const latency = Number.isFinite(data.latency_ms)
    ? `${(data.latency_ms / 1000).toFixed(2)} s`
    : 'time not reported';
  const cost = Number.isFinite(data.usage?.cost_usd)
    ? `$${data.usage.cost_usd.toFixed(6)}`
    : 'cost not reported';
  const inputTokens = data.usage?.input_tokens;
  const outputTokens = data.usage?.output_tokens;
  const tokens = Number.isFinite(inputTokens) && Number.isFinite(outputTokens)
    ? ` · ${inputTokens} in / ${outputTokens} out tokens`
    : '';
  return `${route} · ${model} · ${latency} · ${cost}${tokens}`;
}

async function showLab() {
  let data;
  try {
    data = await request('/api/ask-why-lab');
  } catch (error) {
    if (error.status === 401) return showLogin();
    return showLogin(error instanceof Error ? error.message : 'Could not verify access.');
  }

  const tasks = data.tasks ?? [];
  const configuration = data.configuration ?? {};
  app.innerHTML = `
    <section class="card header-row">
      <div><p class="eyebrow">Olympiad Academy · Internal</p><h1>Ask Why Lab</h1></div>
      <div class="align-right"><p class="muted">${escapeHtml(data.email ?? '')}</p><button id="logout" class="secondary">Sign out</button></div>
    </section>
    <section class="card">
      <p>This lab sends one Uzbek question to the paid Gemma route through OpenRouter after a learner has completed the task. It stores neither the question nor the reply.</p>
      <p class="configuration"><strong>Active route:</strong> ${escapeHtml(configuration.gateway ?? 'OpenRouter')} · ${escapeHtml(configuration.model ?? 'unknown model')} · ${escapeHtml(configuration.route ?? 'paid')}</p>
      <p class="muted">Review language, mathematical correctness, Grade 5 clarity, and whether the response stays focused on this task.</p>
    </section>
    <section class="card">
      <label>Teacher-approved task
        <select id="task">${tasks.map((task) => `<option value="${escapeHtml(task.id)}">${escapeHtml(task.label)}</option>`).join('')}</select>
      </label>
      <p id="statement" class="statement"></p>
    </section>
    <section class="card">
      <form id="ask-form">
        <fieldset>
          <legend>Where is the learner in the flow?</legend>
          <label class="radio"><input type="radio" name="state" value="after_correct_answer" checked /> After a correct answer</label>
          <label class="radio"><input type="radio" name="state" value="after_full_walkthrough" /> After the full walkthrough</label>
        </fieldset>
        <label>Question in Uzbek (Latin)
          <textarea id="question" maxlength="500" placeholder="Masalan: Nega 24 ni 36 ga ko'paytiramiz?"></textarea>
        </label>
        <p class="muted">Ask about one specific operation or a visible solution step.</p>
        <button id="ask" type="submit">Ask Why</button>
      </form>
    </section>
    <section id="result" class="card hidden">
      <p><strong>Model response</strong> <span id="reply-status" class="tag"></span></p>
      <p id="reply" class="response"></p>
      <p id="reply-meta" class="telemetry"></p>
    </section>
    <section id="error" class="card error hidden"></section>`;

  const taskSelect = document.querySelector('#task');
  const statement = document.querySelector('#statement');
  const error = document.querySelector('#error');
  const result = document.querySelector('#result');
  const reply = document.querySelector('#reply');
  const replyStatus = document.querySelector('#reply-status');
  const replyMeta = document.querySelector('#reply-meta');
  const selectedTask = () => tasks.find((task) => task.id === taskSelect.value);
  const renderTask = () => { statement.textContent = selectedTask()?.statement ?? ''; };
  renderTask();
  taskSelect.addEventListener('change', renderTask);
  document.querySelector('#logout').addEventListener('click', async () => {
    await request('/api/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  document.querySelector('#ask-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    error.classList.add('hidden');
    result.classList.add('hidden');
    const button = document.querySelector('#ask');
    button.disabled = true;
    button.textContent = 'Asking the model…';
    try {
      const payload = {
        taskId: taskSelect.value,
        completionState: new FormData(event.currentTarget).get('state'),
        question: document.querySelector('#question').value.trim(),
      };
      const data = await request('/api/ask-why-lab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      reply.textContent = data.reply;
      replyStatus.textContent = data.status === 'ok' ? 'shown to reviewer' : 'safe fallback';
      replyMeta.textContent = formatTelemetry(data);
      result.classList.remove('hidden');
    } catch (caught) {
      if (caught?.status === 401) return showLogin('Your session expired. Sign in again.');
      error.textContent = caught instanceof Error ? caught.message : 'The model request failed.';
      error.classList.remove('hidden');
    } finally {
      button.disabled = false;
      button.textContent = 'Ask Why';
    }
  });
}

await showLab();
