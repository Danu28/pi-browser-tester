# Jev (Typesafe System One) Concept → Browser-Tester Enhancement

## What is Jev? (Research Summary)

**Jev** is TypeSafe AI's first **System One Model** (released 2025-09-15, $40M seed, led by DCVC).  
Core thesis: *Existing LLMs are System Two — slow, sequential, string-generating, human-in-the-loop. Automation needs System One — fast, structured, type-safe decisions software can consume directly.*

| Dimension | LLM (System Two) | Jev (System One) |
|-----------|------------------|------------------|
| Training | RLHF/RLVR (human preference / verifiable reward) | **RLCD** — Reinforcement Learning for **Calibrated Decisions** |
| Input | sequential messages (chat) | **structured program state** (text/JSON) |
| Output | **strings** (must parse/validate, can hallucinate/type-error) | **type-safe structured values** — `choice`/`score`/`boolean` with **probabilities + confidence** |
| Sampling | sequential token-by-token | **parallel** — all questions in one request evaluated independently, ~in same time as one |
| Cost | $0.20–$10 / MTok in, ~5× for output | **$0.042 / MTok in, 0 for output** |
| Speed | 3–329 s (frontier) | **70–500 ms, 40–200× faster** (claimed 193× faster, 444× cheaper on workflow evals) |
| Confidence | overconfident, inconsistent | **calibrated** — every answer carries `probabilities` + `confidence` (0–1, concentration) |
| Hallucination | always possible | **mathematically impossible** (schema-constrained, no string generation) |

**Three Primitives (composable, parallel):**

1. **Choice** — pick one of ≤255 named options: `choice({billing: "...", technical:"..."}) → {choice, probabilities: {billing:0.82,…}, confidence:0.73}`
2. **Score** — grade on ordered rubric 2–10 levels: `score(["Can wait","Soon","Today"]) → {score:2.6 (weighted mean), probabilities:{"0":0.05,…}, confidence}`
3. **Noul (boolean)** — `noul("Does ticket ask for refund?") → {probability:0.92, noul:0.92}` (also called `boolean` in AI SDK)

Key patterns: **atomic questions composed in code** (not one mega-question), keep side-effects in code & branch on `confidence`/`probability` thresholds per action risk, pin `jev-latest` → versioned model, `state`+`questions`→`answers` (independent per question, no context-rot), sequential calls for dependencies.

> Sources: typesafe.ai/blog/introducing-system-one-models-and-jev, docs.typesafe.ai, vercel.com/kb/guide/typesafe-jev-and-ai-sdk, refix.ai Jev quickstart, pydantic TypeSafe model docs.

## How Browser-Tester Is Enhanced With Jev

### Problem Before
`browser-tester` was **imperative & stringly-typed**: `click "#shub39"` fails when ids randomize, `eval(innerHTML)` parses strings, healing logged but not scored, no guardrails before destructive `fill(password)` / `click(Login)`, and flaky asserts were binary throw/no-throw.

### Enhancement: Jev-Inspired System One Layer

This extension now embeds a **Jev-compatible decision engine** in `src/session.js` (no new tool, 4 new batch ops: `jev`, `choice`, `score`, `noul`):

**1. State + Questions → Answers (parallel, typed)**
- `state` auto-captured from current page: `{url, title, text(8k), aria, inputs[], hasPassword, hasForm, htmlSnippet}` — mirrors Jev's *structured program state*.
- `questions` map mirrors `client.systemOne({state, questions})` shape from `@typesafe-ai/sdk`:
```js
// one call, 3 questions evaluated in parallel, same latency as one
{op:"jev", questions:{
  pageType:{type:"choice", criteria:{login:"Username + password form with Login button", dashboard:"PIM/Employee management after auth", error:"Invalid credentials banner"}},
  readiness:{type:"score", criteria:["No form","Form present but missing fields","Ready to fill","Ready and submittable"]},
  isLoginPage:{type:"noul", criteria:"This is a login/authentication page"}
}}
→ {answers:{pageType:{choice:"login", probabilities:{login:0.91,dashboard:0.04,error:0.04}, confidence:0.86}, readiness:{score:2.7,…}, isLoginPage:{probability:0.94}}, state:{url,title}, model:"jev-local-heuristic"}
```

**2. Calibrated Confidence Everywhere**
- `choice`/`score` return `probabilities` (softmax over Jaccard + structural boosts) + `confidence = normalized Simpson concentration` (0 uniform → 1 one-hot), matching TypeSafe's `confidence` semantics.
- `noul` returns `probability` (sigmoid logit) + `confidence = |p-0.5|*2`.
- Enables **threshold-gated automation** per Jev guide:

```js
const {isLoginPage, readiness, pageType} = (await jev(...)).answers;
if (isLoginPage.probability < 0.7 || isLoginPage.confidence < 0.6) await sendToHumanReview();
if (readiness.score < 2.5) throw new Error("form not ready — need review");
if (pageType.confidence < 0.6) heuristics uncertain → screenshot + log;
```

**3. Confidence-Aware Healing (replaces flaky id hacks)**
- `_healLocator` already heals `shub/ember/react` random ids via stable attributes; now Jev `choice` can **rank candidate selectors** by probability instead of first-match, and healing logs include confidence for downstream gating.

**4. Verify-Everything Guardrail (Jev's "map-reduce over data" → "verify everything")**
- Before/after destructive steps, insert `noul` verifiers:

```js
[
  {op:"jev", questions:{
    canLogin:{type:"noul", criteria:"Username and password fields are visible and fillable"},
    isPhish:{type:"noul", criteria:"Page is suspicious/phishing vs legitimate OrangeHRM"}
  }},
  {op:"fillForm", fields: {"input[name='username']":"Admin", "input[name='password']":"admin123"}},
  {op:"click", selector:"button[type='submit']"},
  {op:"jev", questions:{ loggedIn:{type:"noul", criteria:"User is logged in and dashboard is visible"}}}
]
```
- Keeps side-effects in code, decisions in model — exactly Jev's *keep side-effects in TypeScript* rule.

**5. Remote Jev Swap (zero code change)**
- If `TYPESAFE_API_KEY` (or `JEV_API_KEY`) is set, `src/session.js:_jevTryRemote` delegates to `https://api.typesafe.ai/v1/system-one/evaluate` with same `state+questions` shape and 1.2s timeout, falling back to local heuristic (logged as `jev-local-heuristic`). Shape is **TypeSafe-compatible**, so swapping `@typesafe-ai/sdk` local heuristic → real Jev is config-only. Vercel AI Gateway (`typesafe-ai/jev`, `experimental_evaluate`) also compatible shape.
- Local heuristic is offline, deterministic, ~0ms, for CI/smoke; remote is calibrated on TypeSafe's frontier model when available.

**6. Batch-Native, Budget-Friendly**
- `jev` is a `cext_batch` op — composes with `extract`/`fillForm`/`assert` in **one LLM call** (e.g., `launch{steps:[extract→jev→fillForm→click→jev]}` = 1 call, ~3k chars, `telemetry` budgeted). `questions` evaluated in parallel internally (no sequential LLM calls), matching Jev's parallel sampler.

### OrangeHRM Login Example (System One Workflow)

See `browser-tester/scenarios/orangehrm-login.json` — the canonical Jev workflow:

```json
{
  "launch": {"url":"https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"},
  "steps":[
    {"op":"extract","auto":true},
    {"op":"jev","questions":{
      "pageType":{"type":"choice","criteria":{
        "login":"Username and password login form with OrangeHRM branding",
        "dashboard":"HRM dashboard with PIM/Leave/My Info modules",
        "error":"Login error or invalid credentials message"
      }},
      "ready":{"type":"score","criteria":["No form","Form visible but not fillable","Form ready to fill (username+password visible)","Fully ready - can submit"]},
      "isLogin":{"type":"noul","criteria":"This is the OrangeHRM login page and form is ready"}
    }},
    {"op":"fillForm","fields":{"input[name='username']":"Admin","input[name='password']":"admin123"}},
    {"op":"click","selector":"button[type='submit']"},
    {"op":"wait","text":"Dashboard","timeout":8000},
    {"op":"jev","questions":{
      "loggedIn":{"type":"noul","criteria":"User is logged in - dashboard or PIM visible and login form no longer shown"},
      "postPage":{"type":"choice","criteria":{"dashboard":"Dashboard/PIM after successful login","login":"Still on login page","error":"Error message shown"}}
    }},
    {"op":"extract","selectors":{"dashboard":"body"},"aria":true}
  ]
}
```

**Threshold policy (per Jev confidence guide):**
- `isLogin.probability >=0.75 && ready.score >=2.5` before filling (reversible).
- `loggedIn.probability >=0.85` to assert success (higher bar for auth); else `assert` with screenshot for human review.

Run offline: `npm run scenario -- browser-tester/scenarios/orangehrm-login.json --report`

### How This Works for Any Site (not just OrangeHRM)

Jev primitives are **site-agnostic** — they operate on the *auto-captured state* (`extract auto` → `{url,title,text,aria,inventory:[{tag,type,name,placeholder,selector}],forms,hasPassword,hasForm}`), which is the same DOM shape on **any framework** (plain HTML, React/Vue/Angular, randomized `shub/ember/mui` ids). You keep the **same 3 question templates**, only swap the `criteria` descriptions:

- **Pattern A — Classify (choice):** `{login vs dashboard vs error}` on OrangeHRM becomes `{form vs listing vs article}` or `{checkout vs cart vs error}` on an e-commerce site. One `choice` call, parallel, typed.
- **Pattern B — Grade readiness (score):** `["No form","Ready to fill","Fully ready"]` is reused on *any* form — selectorshub dummy-form, Stripe checkout, Salesforce — structural boosts (`hasPassword/hasForm/inputs.length`) calibrate automatically.
- **Pattern C — Guardrail (noul):** `"Safe to fill / logged in / error visible"` becomes `"Search results loaded / payment succeeded / captcha present"` — `probability+confidence` gates the next `fill/click` via threshold (`0.75` reversible, `0.85-0.90` destructive).

**Same 1-launch+batch flow on 3 sites:**

```js
// OrangeHRM login (auth):
{op:"jev", questions:{pageType:{type:"choice", criteria:{login:"OrangeHRM login...", dashboard:"PIM..."}}, isLogin:{type:"noul", criteria:"ready"}}}
// SelectorsHub dummy-form (random ids):
{op:"jev", questions:{pageType:{type:"choice", criteria:{form:"form with randomized ids", listing:"practice table"}}, safeToFill:{type:"noul", criteria:"inputs visible+enabled"}}}
// Any e-commerce checkout (generic):
{op:"jev", questions:{readiness:{type:"score", criteria:["No cart","Cart ready","Checkout ready"]}, canPay:{type:"noul", criteria:"card fields fillable"}}}
```
→ All return `{answers:{...probabilities,confidence}, state:{url,inputs}}`, branch with same code:
```js
if (safeToFill.probability < 0.75) await humanReview();
if (readiness.score < 2.5) throw "not ready";
```
- **Healing stays generic:** `extract auto` emits stable selectors (`input[name='email']`, `button:has-text("Pay")`) that survive randomization; `choice` can rank multiple selector candidates by probability instead of first-match.
- **Cost/latency unchanged:** local heuristic ~0ms / remote Jev 70-500ms, `$0.042/MTok in`, adding Qs doesn't increase time (parallel sampler). Record once → `node scripts/scenario.mjs browser-tester/scenarios/any-site-jev.json --report` replays **zero LLM calls**.

**Template to copy for your site:** `browser-tester/scenarios/any-site-jev.json` (selectorshub demo). Replace `launch.url` + `criteria` strings + `fillForm` fields — keep `questions` structure, thresholds, and `wait` for async SPA render.

### Future Path (if Typesafe access granted)
1. Pin `jev-latest` → `jev-1.13` (or current stable), log `response.model` per decision.
2. Build labeled set of OrangeHRM states (login/dashboard/error) + tune thresholds on false-automation vs unnecessary-review.
3. Add rubric-based `score` for heal confidence and use it to auto-heal selector ranking.
4. Wire Vercel AI Gateway `experimental_evaluate` for observability/logs/budgets/ZDR.

*Design follows Jev's atomic-questions-in-code, parallel evaluation, calibrated confidence, and verify-everything principles — implemented locally for zero-cost CI, swappable to real Jev via env key.*
