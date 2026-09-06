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
- Then `npm install` inside the copied folder (its `package.json` declares
  `playwright`).
- First `cext_launch` downloads Chromium (~170 MB) if missing. `npm run
  install-browser` does the browser download alone.

```
browser-tester/            ← copy this folder
├── index.ts               # pi entry: the cext_* tool table
├── src/session.js         # playwright-only core, no pi imports
├── scripts/               # smoke.mjs (npm run check), install-browser.mjs
└── package.json           # deps + "pi".extensions: ["./index.ts"]
```

## Tools

| Tool | Purpose |
|------|---------|
| `cext_launch` | Launch a real browser. Pass `extensionPath` to load an unpacked extension; omit it for plain website testing. Relaunching = fresh state after edits |
| `cext_open` / `cext_switch` | Navigate (optionally `newTab`, or `waitUntil:'networkidle'` for SPAs) / switch between pages |
| `cext_history` | Browser back / forward navigation |
| `cext_popup` | Open the extension's `action.default_popup` as a page |
| `cext_click` / `cext_fill` / `cext_select` / `cext_hover` | Drive page UI with Playwright selectors: click, fill inputs, pick dropdown options, hover menus/tooltips |
| `cext_press` | Press keys / shortcuts (Tab, Enter, Escape, Control+a, …) — global or after focusing an element (a11y flows) |
| `cext_scroll` | Scroll to a selector, to top/bottom (infinite scroll, lazy-loaded lists), or by x/y pixels — returns the new scroll position |
| `cext_eval` | Run JS in the active page (top-level `await` works; `chrome.*` is available on extension pages) |
| `cext_wait` | Non-throwing wait for a selector, text, or `state:'hidden'` (assertions) |
| `cext_snapshot` / `cext_screenshot` | Read page state; screenshots of the page **or a single element** saved to `./artifacts/` and returned to the model |
| `cext_metrics` | Page load performance: DOMContentLoaded/load timings, transferred bytes, resource counts by type |
| `cext_logs` | Console / page-error / service-worker / network-failure / download logs (filter by level or source) |
| `cext_close_page` | Close one tab (e.g. a tab an extension opens on install) |
| `cext_reload` | Reload the loaded extension via `chrome.runtime.reload()` — no browser relaunch |
| `cext_cdp` | Raw CDP escape hatch (`Network.*`, `Browser.grantPermissions`, `Emulation.*`, …) |
| `cext_serve` | Serve a fixture dir over `http://127.0.0.1` so content scripts inject — `file://` and `data:` pages do NOT run content scripts |
| `cext_close` | Close the browser and any static server |

## Notes

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