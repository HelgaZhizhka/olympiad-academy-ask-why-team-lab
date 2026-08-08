import { acceptInvite, getUser, handleAuthCallback, login, logout } from '@netlify/identity';
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
  if (!response.ok) throw new Error(body.error ?? 'Request failed.');
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
      <p class="muted">Access is invite-only. Use the email address to which you received the Netlify invitation.</p>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      <form id="login-form">
        <label>Email <input id="email" type="email" autocomplete="email" required /></label>
        <label>Password <input id="password" type="password" autocomplete="current-password" required /></label>
        <button type="submit">Sign in</button>
      </form>
    </section>`;

  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = document.querySelector('#email').value.trim();
    const password = document.querySelector('#password').value;
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      await login(email, password);
      await showLab();
    } catch {
      showLogin('Could not sign in. Check the invitation, email, and password.');
    }
  });
}

function showAcceptInvite(token, error = '') {
  app.innerHTML = `
    <section class="card intro">
      <p class="eyebrow">Olympiad Academy · Internal</p>
      <h1>Set your password</h1>
      <p>Your team invitation has been verified. Create a password for this Ask Why Lab account.</p>
    </section>
    <section class="card narrow">
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      <form id="invite-form">
        <label>New password <input id="new-password" type="password" autocomplete="new-password" minlength="8" required /></label>
        <label>Repeat password <input id="confirm-password" type="password" autocomplete="new-password" minlength="8" required /></label>
        <button type="submit">Create account</button>
      </form>
    </section>`;

  document.querySelector('#invite-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = document.querySelector('#new-password').value;
    const confirmation = document.querySelector('#confirm-password').value;
    if (password !== confirmation) return showAcceptInvite(token, 'The passwords do not match.');
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      await acceptInvite(token, password);
      await showLab();
    } catch {
      showAcceptInvite(token, 'Could not create the account. Try a longer password or request a new invitation.');
    }
  });
}

async function showLab() {
  const user = await getUser();
  if (!user) return showLogin();

  let data;
  try {
    data = await request('/.netlify/functions/ask-why-lab');
  } catch (error) {
    return showLogin(error instanceof Error ? error.message : 'Could not verify access.');
  }

  const tasks = data.tasks ?? [];
  app.innerHTML = `
    <section class="card header-row">
      <div><p class="eyebrow">Olympiad Academy · Internal</p><h1>Ask Why Lab</h1></div>
      <div class="align-right"><p class="muted">${escapeHtml(user.email ?? '')}</p><button id="logout" class="secondary">Sign out</button></div>
    </section>
    <section class="card">
      <p>This lab sends one Uzbek question to the currently configured model after a learner has completed the task. It stores neither the question nor the reply.</p>
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
          <textarea id="question" maxlength="500">Nega bu qadamni qilish kerakligini sodda qilib tushuntirib bera olasizmi?</textarea>
        </label>
        <button id="ask" type="submit">Ask Why</button>
      </form>
    </section>
    <section id="result" class="card hidden"><p><strong>Model response</strong> <span id="reply-status" class="tag"></span></p><p id="reply" class="response"></p></section>
    <section id="error" class="card error hidden"></section>`;

  const taskSelect = document.querySelector('#task');
  const statement = document.querySelector('#statement');
  const error = document.querySelector('#error');
  const result = document.querySelector('#result');
  const reply = document.querySelector('#reply');
  const replyStatus = document.querySelector('#reply-status');
  const selectedTask = () => tasks.find((task) => task.id === taskSelect.value);
  const renderTask = () => { statement.textContent = selectedTask()?.statement ?? ''; };
  renderTask();
  taskSelect.addEventListener('change', renderTask);
  document.querySelector('#logout').addEventListener('click', async () => { await logout(); showLogin(); });

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
      const data = await request('/.netlify/functions/ask-why-lab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      reply.textContent = data.reply;
      replyStatus.textContent = data.status === 'ok' ? 'shown to reviewer' : 'safe fallback';
      result.classList.remove('hidden');
    } catch (caught) {
      error.textContent = caught instanceof Error ? caught.message : 'The model request failed.';
      error.classList.remove('hidden');
    } finally {
      button.disabled = false;
      button.textContent = 'Ask Why';
    }
  });
}

try {
  const callback = await handleAuthCallback();
  if (callback?.type === 'invite' && callback.token) {
    showAcceptInvite(callback.token);
  } else {
    await showLab();
  }
} catch {
  showLogin('Identity is unavailable or the invitation link has expired.');
}
