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

- Copy the **whole `browser-tester/` folder** (this repo's only source dir) to
  `~/.pi/agent/extensions/browser-tester/` (global) or
  `<project>/.pi/extensions/browser-tester/` (project-local; auto-discovery
  uses `index.ts` — no config needed). Or `pi install` this repo, whose root
  `package.json` points at `./browser-tester/index.ts`.
- Or run `install.bat` (Windows) — it copies `browser-tester/` to
  `%USERPROFILE%\.pi\agent\extensions\browser-tester\`, deleting any previous
  copy first, so re-run it after every edit.
- No setup inside the copied folder. `playwright` is an ordinary **global** npm
  package: `npm install -g playwright` (first `cext_launch` runs it for you if
  missing). Nothing is installed into the extension folder, so deleting or
  re-copying it never re-downloads anything.
- First `cext_launch` downloads Chromium (~170 MB) if missing. `npm run
  install-browser` does the browser download alone.

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

- Same ops as `cext_batch` (`click`/`fill`/`press`/`select`/`hover`/`wait`/`open`/`switch`/`closePage`/`scroll`/`history`/`eval`/`screenshot`/`logs`/`metrics`).
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
  batch) is the only thing that ships body text. End batches with an `eval`
  returning the assertions you care about, leave screenshots at path-only, and
  put any flow you will repeat in `scenarios/` — then it costs zero model calls
  to re-run.
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