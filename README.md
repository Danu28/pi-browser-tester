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
| `cext_open` / `cext_switch` | Navigate (optionally `newTab`) / switch between pages |
| `cext_popup` | Open the extension's `action.default_popup` as a page |
| `cext_click` / `cext_fill` | Drive page UI with Playwright selectors |
| `cext_eval` | Run JS in the active page (top-level `await` works; `chrome.*` is available on extension pages) |
| `cext_wait` | Non-throwing wait for a selector, text, or `state:'hidden'` (assertions) |
| `cext_snapshot` / `cext_screenshot` | Read page state; screenshots saved to `./artifacts/` and returned to the model |
| `cext_logs` | Console / page-error / service-worker / network-failure / download logs (filter by level or source) |
| `cext_close_page` | Close one tab (e.g. the tab an extension opens on install) |
| `cext_reload` | Reload the extension via `chrome.runtime.reload()` — no browser relaunch |
| `cext_cdp` | Raw CDP escape hatch (`Network.*`, `Browser.grantPermissions`, …) |
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
  (`scripts/smoke.mjs`), runnable without pi or a browser.