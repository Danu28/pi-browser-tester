# browser-extension-tester

A pi extension that loads any unpacked Chrome extension into a real
Playwright-driven Chromium (Chrome for Testing) and lets the coding agent drive
it end to end: popup flows, content scripts, service workers, screenshots, and
console logs.

## Install

- `pi install` this package, or copy the repo folder to
  `~/.pi/agent/extensions/` (drop-in auto-discovery uses `index.ts`).
- First `cext_launch` auto-installs the playwright package (into this folder's
  `node_modules`) and downloads Chromium (~170 MB) if missing. `npm run
  install-browser` does the browser download alone.

## Tools

| Tool | Purpose |
|------|---------|
| `cext_launch` | Launch the browser with the unpacked extension at `<path>`; relaunching = fresh state after edits |
| `cext_open` / `cext_switch` | Navigate / switch between pages |
| `cext_popup` | Open the extension's `action.default_popup` as a page |
| `cext_click` / `cext_fill` | Drive page UI with Playwright selectors |
| `cext_eval` | Run JS in the active page |
| `cext_wait` | Non-throwing wait-for-element (assertions) |
| `cext_snapshot` / `cext_screenshot` | Read page state; screenshots saved to `./artifacts/` and returned to the model |
| `cext_logs` | Console / page-error / service-worker logs |
| `cext_serve` | Serve a fixture dir over `http://127.0.0.1` so content scripts inject — `file://` and `data:` pages do NOT run content scripts |
| `cext_close` | Close the browser and any static server |

## Notes

- Only Chromium-based browsers can side-load extensions. Branded Chrome/Edge
  137+ removed `--load-extension`; use the default `chromium` channel (or older
  `chrome`/`msedge` builds).
- Headless mode is unreliable for extensions — keep the default windowed mode.
- `cext_popup` loads the popup as a tab, not a real action popup: popup sizing
  and `window.close()` behavior may differ.

## Troubleshooting

- **Chromium fails to download** — retry with a mirror:
  `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npm run install-browser`
  Or download the Chrome for Testing zip from
  https://googlechromelabs.github.io/chrome-for-testing/ and extract it to
  `%LOCALAPPDATA%/ms-playwright/chromium-<revision>/` (Windows) or
  `~/.cache/ms-playwright/chromium-<revision>/` (macOS/Linux), adding an
  `INSTALLATION_COMPLETE` marker file.
- **`npm run check`** — zero-dependency smoke test for the pure core logic
  (`scripts/smoke.mjs`), runnable without pi or a browser.