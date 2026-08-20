# Olympiad Academy — Ask Why Team Lab

An internal, invite-only test surface for the selected free Uzbek Ask Why model.
It is deliberately separate from both the production application and the public
prototype.

This branch (`railway`) runs as a single small Node server on Railway. The
`codex/secure-ask-why-lab` branch keeps the previous Netlify Identity variant.

## What it does

- team members sign in with their email and a shared team access code;
- the session lives in a signed, HttpOnly cookie;
- the server exposes only the visible task statement to the browser;
- the server holds the Google AI Studio key, versioned private prompt, canonical answer,
  and teacher-reviewed solution steps;
- the model call is `gemma-4-26b-a4b-it` on the Google AI Studio free tier unless
  overridden;
- server validation rejects empty, Cyrillic, or more-than-two-sentence replies;
- a failed validation, timeout, or provider error shows a neutral Uzbek retry;
- each signed-in reviewer has an in-memory limit of 30 model calls per hour.

It does **not** store questions, responses, child data, or chat history. It is
not a production backend and must not be used with children.

## Railway setup

1. Create a new Railway project → **Deploy from GitHub repo** → pick this
   repository and the `railway` branch.
2. Add the environment variables below.
3. In **Settings → Networking**, generate a public domain.

Railway builds with `npm install && npm run build` and starts `npm start`
automatically.

| Variable | Required | Notes |
| --- | --- | --- |
| `GOOGLE_AI_STUDIO_API_KEY` | One of the two keys | Tried first; native Gemini API. |
| `OPENROUTER_API_KEY` | One of the two keys | Automatic fallback via the OpenRouter `:free` pool. |
| `ASK_WHY_LAB_TASKS_JSON` | Yes | Private teacher-approved task context. |
| `TEAM_ACCESS_CODE` | Yes | Shared sign-in code for the team; rotate it to revoke access. |
| `SESSION_SECRET` | No | Cookie-signing secret; without it sessions reset on redeploy. |
| `ASK_WHY_LAB_MODEL` | No | Defaults to `gemma-4-26b-a4b-it`; OpenRouter-style names are normalised. |

The evaluated prompt is the versioned private source file
[`prompts/ask-why.post-completion.v5.mjs`](./prompts/ask-why.post-completion.v5.mjs).
The server imports it directly. Do **not** set `ASK_WHY_LAB_SYSTEM_PROMPT`: an
environment copy could drift away from the prompt used in regression tests.

`ASK_WHY_LAB_TASKS_JSON` must be a JSON array. Do not commit it:

```json
[
  {
    "id": "G5-UZ-0001",
    "label": "G5-UZ-0001 — internal label",
    "statement": "Uzbek learner-facing task statement",
    "correctAnswer": "canonical answer",
    "solutionSteps": ["teacher-reviewed step 1", "teacher-reviewed step 2"]
  }
]
```

## Local run

```bash
npm install
npm run build
TEAM_ACCESS_CODE=dev GOOGLE_AI_STUDIO_API_KEY=... ASK_WHY_LAB_TASKS_JSON='[...]' npm start
```

The lab is then available on http://localhost:3000.
