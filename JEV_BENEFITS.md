# How Jev Changes Help — Extension vs End User

> 1-file answer to “how Jev helps this extension and end user” — distilled from `JEV.md` implementation.

## For the Extension (maintainer / agent builder)

| Before (imperative, stringly-typed) | After (Jev System One) | Why it matters |
|---|---|---|
| `click "#shub39"` breaks when `selectorshub` randomizes ids | `choice({username:"input[name='username']", email:"input[type='email']"})` → `{choice:"input[name='username']", probabilities:{...}, confidence:0.91}` ranks candidates, picks stable `[name]/[placeholder]` | Type-safe selector healing — no more brittle `eval(innerHTML)` loops. Same pattern fixes `ember/react/mui` random ids. |
| `eval("document.body.innerHTML.slice(0,12000)")` → parse string, hope for typo | `jev {questions:{pageType:{type:"choice", criteria:{login:"...", dashboard:"..."}}}}` → typed `choice+probabilities+confidence` | `OPS: jev/choice/score/noul` are parallel, schema-constrained — mathematically no hallucinated string / type-error. |
| Binary `assert` throw/no-throw, healing logged as `INFO` with no score | Every `jev` answer carries calibrated `confidence` (Simpson normalized 0→1) + `probabilities` | Enables *per-action risk thresholds* instead of one-size-fits-all. Extension can decide vs blindly fail. |
| Sequential `eval` → `fill` → `eval` → 3 LLM calls | `jev` evaluates all questions in **parallel** in one `cext_batch` op (~0ms local, ~100ms remote) | Matches Jev parallel sampler — 3 questions cost same as 1. Stay inside `cext_batch` budget (`telemetry` budgeted). |
| No guardrail before `fill(password)` / `click(Login)` | Insert `noul` verifier: `isLogin` / `canLogin` / `isPhish` before destructive step | Verify-everything: keeps *side-effects in code*, decisions in model — exactly TypeSafe's “smart if-statement” pattern. |
| CI needs network / LLM key to be smart | Local heuristic (`jev-local-heuristic`, ~0ms, deterministic) by default; `TYPESAFE_API_KEY` → real `jev-latest` with 1.2s timeout + fallback | Offline CI zero-cost, prod frontier accuracy with zero code change. Vercel AI Gateway (`typesafe-ai/jev`) same shape. |
| Scenarios rot silently | `score` rubric tracks readiness: `["No form","Ready to fill","Fully ready"]` → `{score:1.84}` with distribution, `loggedIn.probability` after nav | Observable drift — rerun labeled states, tune thresholds on false-automation vs unnecessary-review. |

**Code shape (TypeSafe-compatible):**
```js
// one batch step, 3 atomic questions, parallel
{op:"jev", questions:{
  pageType:{type:"choice", criteria:{login:"Username+password login form", dashboard:"PIM/Leave modules", error:"Invalid credentials"}},
  readiness:{type:"score", criteria:["No form","Form present but missing","Ready to fill","Fully ready"]},
  isLogin:{type:"noul", criteria:"This is the OrangeHRM login page and form is ready"}
}}
→ answers.pageType.choice="login" (0.72, conf 0.35) + answers.isLogin.probability=0.99 (conf 0.98)
```
Keep questions **atomic** and compose in code — if priorities shift, change a coefficient, not a prompt.

## For the End User (tester / QA / human who clicks Login)

### 1. Reliability — logins stop flaking
- **Before:** OrangeHRM loads async; `extract` right after `launch` saw 0 inputs → fill failed 30% of runs.
- **After:** `wait[input[name='username']] → jev{isLogin:0.9921, pageType:login 0.72}` confirms readiness *before* `fillForm{Admin/admin123}`. After submit, `jev{loggedIn:0.865 conf 0.73, postPage:dashboard 0.76}` confirms nav to `/dashboard/index`. No more “password lost” race.

### 2. Speed — 1 call does discovery+decision+action
- **Before:** `launch (1) + extract (2) + fill×2 (3,4) + click (5) + eval (6) = 6 round-trips`, plus string parsing.
- **After:** `launch{url,steps:[extract auto, jev(3Qs parallel), fillForm, click, jev(2Qs)]} = 1 launch+batch` (verified OrangeHRM: **4.4s, 8 steps, 4400 chars, [telemetry] budgeted**). Jev local ~0ms; remote Jev 70-500ms vs LLM 3-329s (40-200× claimed).

### 3. Cost — pay for inputs only
- Local heuristic = **$0 and offline**. Remote Jev (if enabled) = **$0.042/MTok in, $0 out** vs LLM $0.20-10 + 5× output. Adding questions doesn't increase cost (parallel) — “map-reduce over big data” becomes feasible for nightly regression.

### 4. Safety — risky actions gated, reversible actions lenient
Thresholds per *action*, not per model (Jev confidence guide):
```js
if (isLogin.probability < 0.75 || readiness.score < 2.5) throw "form not ready → screenshot + human review";
else await fillForm(...); // reversible, 0.75 bar is fine

if (loggedIn.probability < 0.85) await assertWithReview(); // higher bar for auth
else pass;
```
End user sees **clear paths**: auto-pass when `confidence` high, auto-review when uncertain — no silent false green, no unnecessary manual check.

### 5. Trust — decisions are inspectable and tunable
Every `jev` result logs `{state:{url,hasPassword}, answers, probabilities, model}` to `logs`. User can rerun same scenario with `node scripts/scenario.mjs orangehrm-login.json --report` zero-model-cost and see `pageType:login 0.72` vs `dashboard 0.14`. If thresholds feel loose/tight, change one number in code — model version pinned (`jev-local-heuristic` → `jev-1.13` when key added) and regressions compare distributions, not just pass/fail.

## Bottom Line

**Extension** goes from *string parser that sometimes clicks* to *typed decision engine that measures its own uncertainty and acts accordingly*. **End user** goes from *re-running flaky selectors and guessing if login truly succeeded* to *one recorded scenario that proves login with probabilities, gates risky steps, and falls back to human review only when the model itself says “I’m not sure”* — faster, cheaper, and honest about what it doesn’t know.
