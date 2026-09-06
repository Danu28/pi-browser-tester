// Core browser-driving session for browser-tester.
// Playwright-only: no pi imports, so scripts/smoke.mjs can prove it end to end
// without pi. The pi extension (extensions/index.ts) wraps this in tools.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Root of this package (one level up from src/). All dependency installs below
// happen here so the extension is self-contained no matter how it was placed
// (pi install, or a drop-in copy under ~/.pi/agent/extensions/).
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Resolve the playwright package, lazily. If it is missing (e.g. the extension
// was copied into the global extensions dir and no `npm install` ever ran),
// install it into this package's own node_modules on first use, then retry.
// ESM never caches a failed dynamic import, so the retry re-resolves.
let pwPromise;
function loadPlaywright() {
  pwPromise ??= (async () => {
    try {
      return await import("playwright");
    } catch {}
    console.error(
      "[browser-tester] playwright package not found — running 'npm install' in the extension package to fetch it (one-time)."
    );
    await runInShell("npm install", PKG_ROOT);
    return await import("playwright");
  })();
  return pwPromise;
}

// Run a command line through the platform shell. .cmd/.bat files cannot be
// spawned directly on Windows (spawn EINVAL), so everything goes via
// cmd.exe /c (Windows) or sh -c (POSIX) — works on every platform.
async function runInShell(cmd, cwd, extraEnv = {}) {
  const isWin = process.platform === "win32";
  const child = spawn(isWin ? "cmd.exe" : "/bin/sh", isWin ? ["/d", "/s", "/c", cmd] : ["-c", cmd], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 0) throw new Error(`'${cmd}' failed (exit code ${code})`);
}

const PLAYWRIGHT_DIR = process.platform === "win32" ? "%LOCALAPPDATA%/ms-playwright" : "~/.cache/ms-playwright";

export class NotLaunchedError extends Error {
  constructor() {
    super("Browser not launched. Call cext_launch first.");
    this.name = "NotLaunchedError";
  }
}

const EXT_ID_RE = /chrome-extension:\/\/([a-p]{32})\//;

// Chromium launch flags: extension-testing mode adds the side-load flags, plain
// website-testing mode (launch without extensionPath) gets a vanilla browser.
export function launchArgs(extDir) {
  return extDir
    ? [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
    : [];
}

// Install Playwright's bundled Chromium (Chrome for Testing). Idempotent: exits
// quickly when already present. Uses a 600s download timeout — playwright's
// default 30s is too short on slow links and fails installs for many users.
export async function installChromium() {
  console.error(
    "[browser-tester] Playwright's Chromium is missing — downloading it now (Chrome for Testing, ~170 MB). " +
      "This happens once; it may take a few minutes on slow links."
  );
  try {
    // Runs in the extension package dir so the local playwright CLI resolves
    // even when none is installed globally. 600s timeout: playwright's default
    // 30s is too short on slow links and fails installs for many users.
    await runInShell("npx playwright install chromium", PKG_ROOT, {
      PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: "600000",
    });
  } catch (e) {
    throw new Error(
      `Chromium install failed: ${e.message}\n` +
        `If the download CDN is blocked, set PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright before retrying, ` +
        `or download the Chrome for Testing zip manually (googlechromelabs.github.io/chrome-for-testing) ` +
        `and extract it into ${PLAYWRIGHT_DIR}/chromium-<revision>/ with an INSTALLATION_COMPLETE marker file.`
    );
  }
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

export class ChromeExtSession {
  constructor() {
    this.context = null;
    this.activePage = null;
    this.extId = null;
    this.extDir = null;
    this.artifactsDir = null;
    this.userDataDir = null;
    this.server = null;
    this.serverDir = null;
    this.logEntries = [];
    this.logSeq = 0;
    this._cdp = null;
  }

  _pushLog(source, level, text) {
    this.logEntries.push({ i: this.logSeq++, ts: Date.now(), source, level, text: String(text) });
    if (this.logEntries.length > 5000) this.logEntries.splice(0, this.logEntries.length - 5000);
  }

  _attachHooks() {
    const ctx = this.context;
    ctx.on("console", (msg) =>
      this._pushLog(msg.page() ? "page" : "worker", msg.type(), msg.text())
    );
    // BrowserContext has no 'pageerror' event in modern Playwright: unhandled
    // page exceptions surface via 'weberror' with a WebError ({ error(), page() }).
    ctx.on("weberror", (we) => {
      const err = we.error();
      this._pushLog("page", "pageerror", `${err.message}\n${err.stack ?? ""}`);
    });
    ctx.on("serviceworker", (sw) => {
      this._pushLog("workerevent", "info", `service worker registered: ${sw.url()}`);
      sw.on("console", (msg) => this._pushLog("worker", msg.type(), msg.text()));
    });
    // Extensions live or die by network behaviour (broken-link checkers, ad
    // blockers, request loggers), so surface failures and 4xx/5xx as logs.
    ctx.on("requestfailed", (r) =>
      this._pushLog("network", "error", `${r.method()} ${r.url()} — ${r.failure()?.errorText ?? "failed"}`)
    );
    ctx.on("response", (r) => {
      // Response has no method(): the verb is on Response.request(). Calling
      // r.method() threw on the first 4xx/5xx and killed the host process
      // (Playwright emits from its dispatcher, so the throw is uncatchable here).
      if (r.status() >= 400) this._pushLog("network", "warning", `HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
    });
    ctx.on("download", async (d) => {
      // Exports (report .pdf/.doc/.zip) are a common extension flow: keep the
      // file on disk so the agent can inspect it instead of losing it.
      const name = d.suggestedFilename();
      this._pushLog("download", "info", `${name}`);
      try {
        await d.saveAs(join(this.artifactsDir, name));
      } catch (e) {
        this._pushLog("download", "error", `${name} — ${e.message}`);
      }
    });
  }

  _scanExtId() {
    const ctx = this.context;
    if (!ctx) return undefined;
    const candidates = [
      ...ctx.serviceWorkers().map((sw) => sw.url()),
      ...ctx.backgroundPages().map((p) => p.url()),
      ...ctx.pages().map((p) => p.url()),
    ];
    for (const url of candidates) {
      const m = EXT_ID_RE.exec(url);
      if (m) return m[1];
    }
    return undefined;
  }

  // Chromium's ID: first 16 bytes of the SHA-256, hex mapped to the a-p alphabet.
  _idFromBytes(bytes) {
    return this._hexToId(createHash("sha256").update(bytes).digest("hex").slice(0, 32));
  }

  // map hex chars to the extension alphabet: 0-9 -> a-j, a-f -> k-p
  _hexToId(hex) {
    return [...hex]
      .map((c) =>
        c <= "9"
          ? String.fromCharCode(c.charCodeAt(0) + 49) // '0'-'9' -> 'a'-'j'
          : String.fromCharCode(c.charCodeAt(0) + 10) // 'a'-'f'  -> 'k'-'p'
      )
      .join("");
  }

  /**
   * Derive the ID exactly like Chromium does for unpacked extensions
   * (components/crx_file/id_util.cc GenerateIdForPath): SHA-256 of the bytes
   * of the absolute path as base::FilePath stores them (UTF-16LE on Windows,
   * UTF-8 elsewhere), hex of the first 16 bytes, then map to the a-p alphabet.
   * Used when the extension has no service worker/background page (e.g.
   * popup-only) so no chrome-extension:// target exists to scan.
   */
  _extIdFromPath(dir) {
    if (process.platform === "win32" && /^[a-z]:/.test(dir)) {
      // Chromium's MaybeNormalizePath uppercases the drive letter before hashing;
      // resolve() does not, so a lowercase drive would otherwise yield a wrong ID.
      dir = dir.charAt(0).toUpperCase() + dir.slice(1);
    }
    return this._idFromBytes(Buffer.from(dir, process.platform === "win32" ? "utf16le" : "utf8"));
  }

  // manifest "key" (rare in dev): ID = SHA-256 of the base64-decoded key bytes.
  _extIdFromKey(key) {
    return this._idFromBytes(Buffer.from(key, "base64"));
  }

  async _ensurePage() {
    if (!this.context) throw new NotLaunchedError();
    if (!this.activePage || this.activePage.isClosed()) {
      const pages = this.context.pages();
      this.activePage = pages.find((p) => !p.isClosed()) ?? (await this.context.newPage());
    }
    return this.activePage;
  }

  // Every action is the same three steps: resolve the active page, act, snapshot.
  async _act(fn) {
    const page = await this._ensurePage();
    await fn(page);
    return this._snapshot();
  }

  async _snapshot() {
    const page = await this._ensurePage();
    let bodyText = "";
    try {
      bodyText = (await page.evaluate(() => document.body?.innerText ?? "")).slice(0, 12000);
    } catch {
      // non-HTML content (json/xml/pdf) — no body text
    }
    // Index by object identity, not URL: two tabs on the same URL (common after
    // an extension opens a tab of its own) must not report the wrong active one.
    const open = this.context.pages().filter((p) => !p.isClosed());
    const activeIndex = open.indexOf(page);
    const pages = open.map((p, index) => ({ index, url: p.url() }));
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      bodyText,
      pages,
      activeIndex,
      extId: this.extId,
    };
  }

  _readManifest() {
    let raw;
    try {
      raw = readFileSync(join(this.extDir, "manifest.json"), "utf8");
    } catch {
      throw new Error(`No manifest.json in extension path: ${this.extDir}`);
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`manifest.json in ${this.extDir} is not valid JSON: ${e.message}`);
    }
  }

  // Prefer the real ID from a live chrome-extension:// target; fall back to
  // deriving it for popup-only extensions that have no worker/page to scan.
  async _resolveExtId(manifest) {
    for (let i = 0; i < 50; i++) {
      const id = this._scanExtId();
      if (id) return id;
      await new Promise((r) => setTimeout(r, 200));
    }
    return typeof manifest.key === "string"
      ? this._extIdFromKey(manifest.key)
      : this._extIdFromPath(this.extDir);
  }

  async launch({ extensionPath, url, headless = false, channel = "chromium", cwd = process.cwd(), onProgress = () => {} }) {
    // No extensionPath = plain website-testing mode (no side-load flags below).
    this.extDir = extensionPath ? resolve(cwd, extensionPath) : null;
    // Resolve playwright (auto-installing the package into this extension's own
    // node_modules on first use if it was never installed).
    const chromium = (await loadPlaywright()).chromium;
    // First-use convenience: the bundled browser hasn't been downloaded yet, so
    // fetch it automatically instead of erroring. Idempotent when present.
    if (channel === "chromium" && !existsSync(chromium.executablePath())) {
      onProgress("Chromium missing — installing Playwright's Chrome for Testing (~170 MB, one-time download)");
      await installChromium();
      if (!existsSync(chromium.executablePath())) {
        throw new Error(
          `Chromium still missing after install attempt. Run 'npm run install-browser' manually and check the README troubleshooting section.`
        );
      }
    }
    const manifest = this.extDir ? this._readManifest() : {};
    await this.close(); // relaunch = fresh state, also acts as "reload after edits"
    this.logEntries = [];
    this.logSeq = 0;
    this.extId = null;
    this.artifactsDir = join(cwd, "artifacts");
    mkdirSync(this.artifactsDir, { recursive: true });
    this.userDataDir = join(tmpdir(), `cext-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      this.context = await chromium.launchPersistentContext(this.userDataDir, {
        headless,
        ...(channel ? { channel } : {}),
        // Playwright's default args include --disable-extensions; drop it or
        // --load-extension below is a no-op.
        ignoreDefaultArgs: ["--disable-extensions"],
        args: launchArgs(this.extDir),
      });
    } catch (err) {
      // Branded Chrome/Edge 137+ removed --load-extension and
      // --disable-extensions-except, so only Playwright's bundled Chromium
      // (default channel) or old browsers (<137) can side-load extensions.
      throw new Error(
        `Could not launch browser: ${err.message}\n` +
          `Default channel is 'chromium' (Playwright's Chrome for Testing). Run 'npx playwright install chromium' if the executable is missing.`
      );
    }
    this._attachHooks();

    // Plain mode (no extension) has nothing to scan: extId stays null.
    if (this.extDir) this.extId = await this._resolveExtId(manifest);

    await this._ensurePage();
    if (url) await this.open(url);

    const workers = this.context.serviceWorkers();
    return {
      extId: this.extId,
      extDir: this.extDir,
      popupPath: manifest.action?.default_popup ?? null,
      serviceWorkers: workers.map((w) => w.url()),
      backgroundPages: this.context.backgroundPages().map((p) => p.url()),
      page: this.activePage.url(),
    };
  }

  async close() {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.serverDir = null;
    }
    if (this.context) {
      try {
        await this.context.close();
      } catch {}
      this.context = null;
      this.activePage = null;
    }
    if (this.userDataDir && existsSync(this.userDataDir)) {
      rmSync(this.userDataDir, { recursive: true, force: true });
      this.userDataDir = null;
    }
    return { closed: true };
  }

  async open(url, { newTab = false, waitUntil = "domcontentloaded" } = {}) {
    if (!this.context) throw new NotLaunchedError();
    const page = newTab ? await this.context.newPage() : await this._ensurePage();
    if (newTab) this.activePage = page;
    await page.goto(url, { waitUntil });
    return this._snapshot();
  }

  // Close one page (e.g. the marketing tab an extension opens on install) so it
  // stops confusing active-tab resolution, without tearing down the session.
  async closePage(index) {
    if (!this.context) throw new NotLaunchedError();
    const pages = this.context.pages().filter((p) => !p.isClosed());
    const page = index == null ? await this._ensurePage() : pages[index];
    if (!page) throw new Error(`No page at index ${index} (have ${pages.length})`);
    await page.close();
    if (this.activePage === page) this.activePage = null;
    return this._snapshot();
  }

  // Reload just the extension (chrome.runtime.reload() in its own worker/page)
  // instead of relaunching the whole browser after every source edit.
  async reloadExtension() {
    if (!this.context) throw new NotLaunchedError();
    const target = this.context.serviceWorkers()[0] ?? this.context.backgroundPages()[0];
    if (!target) throw new Error("No service worker or background page — nothing to reload");
    // reload() tears down the worker, so the evaluate call itself rejects.
    await target.evaluate(() => chrome.runtime.reload()).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    return {
      reloaded: true,
      serviceWorkers: this.context.serviceWorkers().map((w) => w.url()),
      backgroundPages: this.context.backgroundPages().map((p) => p.url()),
    };
  }

  // Escape hatch: raw CDP for anything the tool set does not wrap (permissions,
  // Network.*, Emulation.*, …). target: "page" (default) or "browser".
  async cdp(method, params = {}, { target = "page" } = {}) {
    if (!this.context) throw new NotLaunchedError();
    this._cdp ??= new Map();
    const browser = target === "browser";
    const key = browser ? "browser" : await this._ensurePage();
    let session = this._cdp.get(key);
    if (!session) {
      session = browser
        ? await this.context.browser().newBrowserCDPSession()
        : await this.context.newCDPSession(key);
      this._cdp.set(key, session);
    }
    return session.send(method, params);
  }

  async popup() {
    if (!this.context) throw new NotLaunchedError();
    if (!this.extDir) throw new Error("No extension loaded — launch with extensionPath to test a popup");
    const popupPath = this._readManifest().action?.default_popup;
    if (!popupPath) throw new Error(`No action.default_popup in manifest`);
    const prev = this.activePage && !this.activePage.isClosed() ? this.activePage : null;
    const page = await this.context.newPage();
    // A real action popup floats over the page without stealing its "active
    // tab" status, so chrome.tabs.query({active, lastFocusedWindow}) inside the
    // popup resolves to the host tab. Playwright's popup is just another tab in
    // the same window, so hand focus back to the host page *before* navigating:
    // popups query their target while loading, i.e. before goto() returns.
    // Without this the extension targets the popup tab itself and refuses to run
    // ("can't run on this browser page").
    // ponytail: Chromium flips the active tab asynchronously after
    // bringToFront, and the popup queries its target while loading, so give
    // focus a moment to settle — without this the fix works only sometimes.
    if (prev) {
      await prev.bringToFront().catch(() => {});
      await new Promise((r) => setTimeout(r, 150));
    }
    this.activePage = page;
    await page.goto(`chrome-extension://${this.extId}/${popupPath}`, {
      waitUntil: "domcontentloaded",
    });
    return this._snapshot();
  }

  async switchPage(index) {
    if (!this.context) throw new NotLaunchedError();
    const pages = this.context.pages().filter((p) => !p.isClosed());
    const page = pages[index];
    if (!page) throw new Error(`No page at index ${index} (have ${pages.length})`);
    this.activePage = page;
    return this._snapshot();
  }

  async snapshot() {
    return this._snapshot();
  }

  async click(selector, { index = 0, timeout = 5000 } = {}) {
    return this._act((page) => {
      const loc = page.locator(selector);
      return (index > 0 ? loc.nth(index) : loc.first()).click({ timeout });
    });
  }

  async fill(selector, value, { timeout = 5000 } = {}) {
    return this._act((page) => page.locator(selector).first().fill(value, { timeout }));
  }

  async hover(selector, { timeout = 5000 } = {}) {
    return this._act((page) => page.locator(selector).first().hover({ timeout }));
  }

  // Dropdowns: plain string matches the option's value attribute; options
  // without a value store their text as value, so retry with {label}.
  async select(selector, value, { timeout = 5000 } = {}) {
    return this._act(async (page) => {
      const loc = page.locator(selector).first();
      await loc.selectOption(value, { timeout }).catch(() => loc.selectOption({ label: value }, { timeout }));
    });
  }

  // Keyboard: with a selector, focus the element first then press; without,
  // press globally on the page (Tab to walk focus for a11y testing, Escape, …).
  async press(selector, key, { timeout = 5000 } = {}) {
    return this._act((page) =>
      selector ? page.locator(selector).first().press(key, { timeout }) : page.keyboard.press(key)
    );
  }

  async history(direction) {
    return this._act((page) =>
      direction === "back"
        ? page.goBack({ waitUntil: "domcontentloaded" })
        : page.goForward({ waitUntil: "domcontentloaded" })
    );
  }

  // Site-testing measurements: navigation timings (ms after navigation start),
  // total transferred bytes, and resource counts by initiator type.
  async metrics() {
    const page = await this._ensurePage();
    return page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const res = performance.getEntriesByType("resource");
      const byType = {};
      for (const r of res) byType[r.initiatorType || "other"] = (byType[r.initiatorType || "other"] || 0) + 1;
      return {
        url: location.href,
        domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        load: nav ? Math.round(nav.loadEventEnd) : null,
        bytes: res.reduce((a, r) => a + (r.transferSize || 0), 0),
        resources: res.length,
        byType,
      };
    });
  }

  async eval(expression) {
    const page = await this._ensurePage();
    // Extension pages expose chrome.*, and agents naturally write
    // `await chrome.tabs.query({})` — a SyntaxError as a plain expression. Retry
    // inside an async IIFE so top-level await works; throw the original error if
    // the wrapped form fails too (i.e. the expression is genuinely broken).
    let raw;
    try {
      raw = await page.evaluate(expression);
    } catch (e) {
      try {
        raw = await page.evaluate(`(async () => (${expression}))()`);
      } catch {
        throw e;
      }
    }
    let text;
    try {
      text = JSON.stringify(raw, null, 2);
    } catch {
      text = String(raw);
    }
    return { result: text.slice(0, 12000), type: raw === null ? "null" : typeof raw };
  }

  async wait(selector, { timeout = 5000, state = "visible", text = undefined } = {}) {
    const page = await this._ensurePage();
    // `text` waits for copy to show up (e.g. "Tests complete") — the common
    // assertion when the extension renders results asynchronously.
    const loc =
      text === undefined
        ? page.locator(selector).first()
        : page.getByText(text, { exact: false }).first();
    try {
      await loc.waitFor({ state, timeout });
      return { found: true };
    } catch {
      return { found: false };
    }
  }

  async screenshot({ fullPage = false, selector = undefined } = {}) {
    const page = await this._ensurePage();
    const buf = selector
      ? await page.locator(selector).first().screenshot()
      : await page.screenshot({ fullPage });
    const name = `cext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    writeFileSync(join(this.artifactsDir, name), buf);
    return { data: buf.toString("base64"), path: join(this.artifactsDir, name) };
  }

  async logs({ level, since = 0, source = undefined } = {}) {
    const entries = this.logEntries.filter(
      (e) => e.i >= since && (!level || e.level === level) && (!source || e.source === source)
    );
    return { entries, next: this.logSeq };
  }

  async serve(dir, { cwd = process.cwd() } = {}) {
    this.serverDir = resolve(cwd, dir);
    if (!existsSync(this.serverDir)) throw new Error(`No such dir: ${this.serverDir}`);
    if (this.server) this.server.close();
    this.server = createServer((req, res) => {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
      } catch {
        // Malformed percent-encoding must not crash the process: an uncaught
        // throw inside the request handler would take down the pi host.
        res.writeHead(400);
        res.end("bad request");
        return;
      }
      let file = resolve(this.serverDir, "." + pathname);
      // Case-insensitive prefix check: Windows FS is case-insensitive, so a
      // valid request must not 403 just because path casing differs.
      const root = this.serverDir.toLowerCase();
      const key = file.toLowerCase();
      if (!key.startsWith(root + sep.toLowerCase()) && key !== root) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      try {
        if (statSync(file).isDirectory()) file = join(file, "index.html");
        res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "text/plain" });
        res.end(readFileSync(file));
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    return { origin: `http://127.0.0.1:${this.server.address().port}` };
  }
}