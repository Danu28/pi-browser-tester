# browser-tester

A pi extension that gives the coding agent a real, Playwright-driven Chromium
(Chrome for Testing) it can drive end to end — for both sides of browser work:

- **Website testing & browser actions**: launch a plain browser (no extension
  needed), open any http(s) page, click/fill/hover/select/press, keyboard and
  history flows, performance metrics, screenshots, and console/network logs.
- **Chrome extension testing**: load any unpacked extension and drive its
  popup flows, content scripts, service workers, and downloads.

All tools are `cext_*` (kept from the extension-testing origin).

## Install

**One-liner (recommended):**

```bash
pi install git:github.com/Danu28/pi-browser-tester
```

Then restart `pi` or run `/reload` — `pi` clones to `~/.pi/agent/git/github.com/Danu28/pi-browser-tester`, runs `npm install` (installs `playwright`), and loads `browser-tester/index.ts` (`cext_*` tools). `pi list` shows it, `pi update --extensions` updates it, `pi remove git:github.com/Danu28/pi-browser-tester` removes it. Works on all platforms, including Termux/Linux/macOS.

Pin a version:
```bash
pi install git:github.com/Danu28/pi-browser-tester@v0.5.0
```
Project-local (shared with team via `.pi/settings.json`):
```bash
pi install -l git:github.com/Danu28/pi-browser-tester
```
Try without installing (temp for this run):
```bash
pi -e git:github.com/Danu28/pi-browser-tester
```

<details><summary>Alternatives</summary>

- **Manual copy:** copy the **whole `browser-tester/` folder** to `~/.pi/agent/extensions/browser-tester/` (global) or `<project>/.pi/extensions/browser-tester/` (project-local; auto-discovery via `index.ts`).
- **Windows helper:** `install.bat` copies `browser-tester/` to `%USERPROFILE%\.pi\agent\extensions\browser-tester\` (deletes previous copy; re-run after edits). It warns `[install] STALE` if installed copy is older than source. Legacy — `pi install` is preferred.

</details>

- No extra setup: `playwright` is installed with the package (`dependencies`). If missing (manual copy), first `cext_launch` installs it globally.
- First `cext_launch` downloads Chromium (~170 MB) if missing. `npm run install-browser` does the browser download alone.

```
browser-tester/            ← copy this folder
├── index.ts               # pi entry: the cext_* tool table
├── src/session.js         # playwright-only core, no pi imports
├── scripts/               # smoke.mjs (npm run check), scenario.mjs, install-browser.mjs
├── scenarios/             # recorded flows replayed with no model in the loop
└── package.json           # deps + "pi".extensions: ["./index.ts"]
```

## Tools

| Tool | Purpose |
|------|---------|
| `cext_launch` | Launch a real browser. Pass `extensionPath` to load an unpacked extension; omit it for plain website testing. Relaunching = fresh state after edits |
| `cext_batch` | **The action surface** — `click`/`fill`/`press`/`select`/`hover`/`wait`/`open`/`switch`/`closePage`/`scroll`/`history`/`eval`/`screenshot`/`logs`/`metrics`, one line per step, `snapshot:true` for the final body text. N steps, one call |
| `cext_snapshot` / `cext_screenshot` | Read page state (URL, title, open pages, body text); screenshots of the page **or a single element** saved to `./artifacts/` (path only by default — `inline:true` returns the image) |
| `cext_logs` | Console / page-error / service-worker / network-failure / download logs (filter by level or source) |
| `cext_popup` | Open the extension's `action.default_popup` as a page |
| `cext_reload` | Pick up extension source edits — relaunches with the same options (a side-loaded extension's service worker never respawns) |
| `cext_serve` | Serve a fixture dir over `http://127.0.0.1` so content scripts inject — `file://` and `data:` pages do NOT run content scripts |
| `cext_cdp` | Raw CDP escape hatch (`Network.*`, `Browser.grantPermissions`, `Emulation.*`, …) |
| `cext_close` | Close the browser and any static server |

Every page action is a `cext_batch` **step**, not a tool of its own: clicking,
filling, waiting, evaluating, scrolling and going back are all ops inside the
one call. The list lives in `OPS` (`src/session.js`) — it is the schema, the
error message and this table's source of truth.

> **Budget: 10 tools — new tool must delete one.** Prompt cost is bounded by tool count; add a batch op (one name + one case in `src/session.js`) instead of a new tool.

**Loop in 3 lines:** `edit → install.bat → cext_reload → cext_batch` — that's the shortest path to green. `install.bat` warns `[install] STALE` if you forgot to re-copy.

## Copy-paste batch examples — 3 flows that teach the pattern

Each example is a single `cext_batch` call ending with an `eval` assertion — thrown error = failed step with index.

**1. Dummy form (stable selector, randomized-id workaround on selectorshub.com):**

The email id is randomized per load (`shub39`, `shub76`, …). Don't use `#shub39` — use a stable attribute:

```json
{
  "steps": [
    { "op": "click", "selector": ".userform input[type='email']" },
    { "op": "fill", "selector": ".userform input[type='email']", "value": "tester@example.com" },
    { "op": "fill", "selector": "#pass", "value": "Str0ngPass!23" },
    { "op": "fill", "selector": ".userform input[name='company']", "value": "Pi Automation" },
    { "op": "eval", "expression": "(async () => { const v = document.querySelector(`.userform input[type='email']`).value; if (!v) throw new Error('email is empty — shub randomized id workaround failed'); return {email: v}; })()" }
  ]
}
```

**2. Payment form — fill, submit and prove it reloaded:**

```json
{
  "steps": [
    { "op": "fill", "selector": "#cardName", "value": "Ada Lovelace" },
    { "op": "fill", "selector": "#cardNumber", "value": "4111 1111 1111 1111" },
    { "op": "fill", "selector": "#expiry", "value": "12/29" },
    { "op": "fill", "selector": "#cvv", "value": "123" },
    { "op": "click", "selector": "button:has-text(\"Pay\")" },
    { "op": "eval", "expression": "(async () => { await new Promise(r => setTimeout(r, 800)); if (!location.href.endsWith('?')) throw new Error('Pay did not submit — url is ' + location.href); return {submitted: true}; })()" }
  ]
}
```

**3. Extension popup — serve, popup, assert via chrome.*:**

```json
{
  "steps": [
    { "op": "open", "url": "http://127.0.0.1:PORT/" },
    { "op": "eval", "expression": "document.body.innerHTML.slice(0,12000)" },
    { "op": "eval", "expression": "(async () => { const tabs = await chrome.tabs.query({active:true, lastFocusedWindow:true}); if (!tabs.length) throw new Error('popup cannot see host tab'); return {tabs: tabs.length}; })()" }
  ]
}
```
*Workflow: `cext_launch` with `extensionPath` → `cext_serve` (dir) → `open` the served URL → `cext_popup` → `cext_batch` as above. Use `eval` with `chrome.*` inside the popup — top-level `await` is retried inside an async IIFE.*

### Selector resilience — 5 rules that prevent flaky flows

- **Stable over random:** prefer `[type='email']`, `[name='company']`, `button:has-text("Pay")` over `#shub39` — selectorshub randomizes ids per load (`shub` prefix is the tell).
- **Probe before you fill:** `eval("document.querySelectorAll('.userform input').length")` or `document.body.innerHTML.slice(0,12000)` to discover selectors without extra round trips.
- **Wait for text, not just selector:** `{ "op": "wait", "text": "Tests complete" }` catches async renders that `wait` on a selector misses.
- **Scroll before below-fold:** `{ "op": "scroll", "to": "bottom" }` or `{ "op": "scroll", "selector": "#footer" }` for lazy-loaded / infinite lists; clicks already scroll their target.
- **Back-nav via history:** `{ "op": "history", "direction": "back" }` instead of re-opening the URL — preserves stack and is one step.

## Brain-efficient — cheapest high-output pattern (new)

**Any site in 1-2 calls.** By default any site needs `launch` + `batch` = 2 calls. With `launch {url, steps:[...]}` it's **1 call** (launch+act). Discovery is one `extract` — no probing.

**Auto-discover any site (unknown selectors):**

```json
{ "op": "extract", "auto": true }
// → { inventory:[{tag:"input", type:"email", placeholder:"Enter email", selector:"input[name='email']", value:""}], forms:[...], _aria:"..." }
```
→ Feed `inventory[].selector` straight into `fillForm` — no manual `eval(innerHTML)` loops. `"auto":true` scans any page (React/Vue/Angular, random ids) and returns stable selectors (`[name]`, `[placeholder]`, `[type]`) that survive `shub46`-style randomization. `heal` also auto-fixes `shub/ember/react` random ids.

**One-batch any-site example (launch+steps = 1 LLM call):**

```json
{
  "url": "https://example.com/form",
  "steps": [
    { "op": "extract", "auto": true },
    { "op": "fillForm", "fields": { "input[name='email']":"a@b.com", "#pass":"x" }},
    { "op": "assert", "checks": [{ "selector": "input[name='email']", "value": "a@b.com" }] }
  ]
}
```
call: `cext_launch {url, steps}` → 1 call does open+discover+fill+assert. Without `steps`, it's 2 calls (`launch` + `batch`).

**One batch, not three.** Old way needed 3 calls (`fill`×5 + `click` + `eval` + `snapshot`) → ~18k chars. New brain-style:

```json
{
  "steps": [
    { "op": "fillForm", "fields": { "#cardName":"Ada Lovelace", "#cardNumber":"4111 1111 1111 1111", "#expiry":"12/29", "#cvv":"123" }},
    { "op": "click", "selector": "button:has-text(\"Pay\")" },
    { "op": "extract", "selectors": { "cardName":"#cardName", "cardNumber":"#cardNumber" }, "aria": true },
    { "op": "assert", "checks": [{ "url": "endsWith:?" }] }
  ]
}
```
→ **2 calls total (launch+batch), ~3k chars, 6× less tokens**. `fillForm` chunks 5 fills into one result line, `extract` returns pruned aria+selectors (compact JSON with `hash/cached/truncated`), `assert` validates url/text/value in one step. Add `record:true` to batch to save `browser-tester/scenarios/auto-<ts>.json` for zero-cost replay (`node scripts/scenario.mjs <file> --report`). Batch returns `[telemetry] 120ms 2400 chars` so you can budget the next call; unchanged `extract`/`snapshot` returns `[cached <hash>]` (0 tokens).

New batch ops: `extract` (selectors+aria), `fillForm` (fields map), `assert` (checks), `upload` (files), `drag` (selector→target), `emulate` (viewport). `select` is now single-timeout via pre-probe, `wait` accepts `fn` JS, `screenshot` errors if `selector+fullPage` both set, downloads dedupe (`name-1.pdf`), artifacts auto-prune (keep 20, >7d deleted, `manifest.json`).

## Recorded scenarios (no model in the loop)

A flow you will run more than once should not cost model round trips at all.
`cext_batch` steps are plain JSON, and `session.batch` is already the
interpreter, so a scenario is just that array on disk:

```json
{
  "launch": { "url": "https://selectorshub.com/xpath-practice-page/" },
  "steps": [
    { "op": "click", "selector": ".userform input[type='email']" },
    { "op": "fill",  "selector": ".userform input[type='email']", "value": "tester@example.com" },
    { "op": "click", "selector": ".userform button" },
    { "op": "eval",  "expression": "(async () => { const v = document.querySelector(`#pass`).value; if (!v) throw new Error(`password lost`); return v; })()" }
  ]
}
```

```sh
npm run scenario -- browser-tester/scenarios/dummy-form.json
# 0 click … — ok
# …
# 7 eval → {"email":"tester@example.com",…}
# ok: 8 steps → https://selectorshub.com/xpath-practice-page/
```

- Same ops as `cext_batch` (`click`/`fill`/`press`/`select`/`hover`/`wait`/`open`/`switch`/`closePage`/`scroll`/`history`/`eval`/`screenshot`/`logs`/`metrics`/`extract`/`fillForm`/`assert`/`upload`/`drag`/`emulate`).
- **Assertions are just thrown errors.** Make the last step an `eval` that reads
  the page and throws when it is wrong; a failed assertion is a failed step.
- Exit `0` on success, `1` naming the failing step (`FAILED at step 3 (click): …`),
  and the browser is always closed — safe to chain in CI.
- The runner is pi-free, so it works from a plain shell: `node
  browser-tester/scripts/scenario.mjs <file.json>`.

Use `cext_*` to *discover* a flow (unknown selectors, visual checks, one-off
pages), then record it here. Scenarios rot when the page changes — re-exploring
is two `cext_batch` calls.

## Notes

- **Cost:** every tool call is one model round trip, so `cext_batch` (N steps,
  one call) is how a flow should be driven. An action returns one line — url and
  title, never the page text — and `cext_snapshot` (or `snapshot:true` on a
  batch) is the only thing that ships body text (now with `[truncated]` / `[cached]` markers). Prefer `extract` over `snapshot` — it ships pruned aria+selectors (~10× smaller). Batch telemetry (`totalMs/totalChars` + per-step `ms/chars`) tells you the budget; leave screenshots at path-only, and
  put any flow you will repeat in `scenarios/` (use `record:true` or `npm run scenario -- file --report`) — then it costs zero model calls
  to re-run.
- **Artifacts:** screenshots and downloads land under `./artifacts/` (cwd-relative). Auto-pruned on launch (keep last 20, delete >7d, `manifest.json` updated); downloads dedupe to `name-1.pdf`. Screenshots are path-only by default; `inline:true` ships ~300–800k chars of base64 — only use when the model must see the image.
- Only Chromium-based browsers can side-load extensions. Branded Chrome/Edge
  137+ removed `--load-extension`; use the default `chromium` channel (or older
  `chrome`/`msedge` builds).
- Headless mode is unreliable for extensions — keep the default windowed mode.
- `cext_popup` loads the popup as a tab, not a real action popup: popup sizing
  and `window.close()` behavior may differ. The previously active page keeps
  browser focus, so `chrome.tabs.query({active, lastFocusedWindow})` inside the
  popup still resolves to the page under test (without this, extensions target
  the popup tab itself and refuse to run).

## Testing a published Web Store extension

Only unpacked folders can be side-loaded, so fetch and unpack the CRX first:

```sh
curl -sL -o ext.crx "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=133.0.0.0&acceptformat=crx2,crx3&x=id%3D<EXTENSION_ID>%26uc%26lang%3Den-US"
python -c "import zipfile; zipfile.ZipFile('ext.crx').extractall('ext-under-test')"   # handles the Cr24 header
```

Then `cext_launch` with `./ext-under-test`. The `update_url` left in the
manifest is ignored for unpacked loads.

## Troubleshooting

- **Chromium fails to download** — retry with a mirror:
  `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npm run install-browser`
  Or download the Chrome for Testing zip from
  https://googlechromelabs.github.io/chrome-for-testing/ and extract it to
  `%LOCALAPPDATA%/ms-playwright/chromium-<revision>/` (Windows) or
  `~/.cache/ms-playwright/chromium-<revision>/` (macOS/Linux), adding an
  `INSTALLATION_COMPLETE` marker file.
- **`npm run check`** — zero-dependency smoke test for the pure core logic
  (`browser-tester/scripts/smoke.mjs`), runnable without pi or a browser.
- **`index.ts`** has no typecheck of its own — pi type-checks it when it loads
  the extension, and `npm run check` covers the pi-free core (`src/session.js`).

## License

MIT — see [LICENSE](LICENSE).
