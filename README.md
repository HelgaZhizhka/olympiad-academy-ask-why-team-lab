# Olympiad Academy — Ask Why Team Lab

An internal, invite-only test surface for the selected free Uzbek Ask Why model.
It is deliberately separate from both the production application and the public
prototype.

## What it does

- invited team members sign in through Netlify Identity;
- the server exposes only the visible task statement to the browser;
- the server holds the OpenRouter key, private prompt, canonical answer, and
  teacher-reviewed solution steps;
- the model call is `google/gemma-4-26b-a4b-it:free` unless overridden;
- server validation rejects empty, Cyrillic, or more-than-two-sentence replies;
- a failed validation, timeout, or provider error shows a neutral Uzbek retry;
- each signed-in reviewer has an in-memory limit of 30 model calls per hour.

It does **not** store questions, responses, child data, or chat history. It is
not a production backend and must not be used with children.

## Netlify setup

1. Create a **new, private** Netlify project from this repository.
2. In **Project configuration → Identity**, enable Identity.
3. In **Identity → Registration**, choose **Invite only**.
4. In **Identity → Users**, invite the team members who should test the lab.
5. Add the environment variables below, then redeploy.

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Yes | Server-only key; never use a `VITE_` prefix. |
| `ASK_WHY_LAB_SYSTEM_PROMPT` | Yes | Private current Ask Why policy prompt. |
| `ASK_WHY_LAB_TASKS_JSON` | Yes | Private teacher-approved task context. |
| `ASK_WHY_LAB_MODEL` | No | Defaults to `google/gemma-4-26b-a4b-it:free`. |

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

## Local build

```bash
npm install
npm run build
```

Identity and the protected function require a Netlify HTTPS deployment. The
local lab remains the quickest way to test with the existing private content.
