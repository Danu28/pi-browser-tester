// Core browser-driving session for browser-tester.
// Playwright-only: no pi imports, so scripts/smoke.mjs can prove it end to end
// without pi. The pi extension (index.ts) wraps this in tools.

import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Root of this package (one level up from src/).
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// playwright is an ordinary global npm package, so this extension folder stays
// dependency-free and nothing is ever installed inside it (a global install is a
// throwaway copy: install.bat deletes and re-copies it). Node does not search
// the global node_modules dir, so ask npm where it is.
function npmGlobalRoot() {
  try {
    return execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// Resolve the playwright package, lazily: node's own lookup (repo dev install),
// then the global install, then install it globally like any npm package.
let pwPromise;
function loadPlaywright() {
  pwPromise ??= (async () => {
    try {
      return await import("playwright");
    } catch {}
    try {
      if (npmGlobalRoot()) return createRequire(pathToFileURL(join(npmGlobalRoot(), "x.cjs")))("playwright");
    } catch {}
    console.error(
      "[browser-tester] playwright package not found — installing it globally with 'npm install -g playwright' (one-time)."
    );
    await runInShell("npm install -g playwright");
    return createRequire(pathToFileURL(join(npmGlobalRoot(), "x.cjs")))("playwright");
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

// Cap on every blob of text headed back to the model (body text, eval output).
const MAX_TEXT = 12000;

// The step vocabulary: every browser action is one of these ops. index.ts builds
// the cext_batch schema from this list and _batchStep rejects anything not in
// it, so adding an op means adding one name here and one case below.
export const OPS = [
  "click", "fill", "press", "select", "hover", "wait", "open", "switch",
  "closePage", "scroll", "history", "eval", "screenshot", "logs", "metrics",
];

// One step result is one line — in pi (cext_batch) and in scripts/scenario.mjs.
export const stepLine = (r) => {
  const head = `${r.i} ${r.op}${r.selector ? ` ${r.selector}` : ""}`;
  return r.error ? `${head} — FAIL: ${r.error}` : `${head} → ${r.result}`;
};

export class NotLaunchedError extends Error {
  constructor() {
    super("Browser not launched. Call cext_launch first.");
    this.name = "NotLaunchedError";
  }
}

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
    // Run from the npm global prefix when playwright is installed globally, so
    // npx picks up that CLI instead of fetching one; else the package dir.
    // 600s timeout: playwright's default 30s is too short on slow links.
    const root = npmGlobalRoot();
    await runInShell(
      "npx playwright install chromium",
      root && existsSync(join(root, "playwright")) ? dirname(root) : PKG_ROOT,
      {
        PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: "600000",
      }
    );
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
    this.manifest = null;
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

  // Every op that needs a browser starts here, so "not launched" has one wording.
  _ctx() {
    if (!this.context) throw new NotLaunchedError();
    return this.context;
  }

  async _ensurePage() {
    const ctx = this._ctx();
    if (!this.activePage || this.activePage.isClosed()) {
      const pages = ctx.pages();
      this.activePage = pages.find((p) => !p.isClosed()) ?? (await ctx.newPage());
    }
    return this.activePage;
  }

  // Every action ends with the same one line — url + title, no body text.
  // cext_snapshot and batch({snapshot:true}) are the only readers of page text,
  // so a 12-step flow does not pay for 12 copies of it.
  async _act(fn) {
    const page = await this._ensurePage();
    await fn(page);
    return this._result(page);
  }

  async _result(page) {
    return { url: page.url(), title: await page.title().catch(() => "") };
  }

  async _snapshot() {
    const page = await this._ensurePage();
    let bodyText = "";
    try {
      bodyText = (await page.evaluate(() => document.body?.innerText ?? "")).slice(0, MAX_TEXT);
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

  // Chromium derives an unpacked extension's ID from its absolute path
  // (id_util.cc GenerateIdForPath); a manifest "key" overrides it. Computing it
  // beats scanning live chrome-extension:// targets for one, which cost up to
  // 10s of polling for popup-only extensions that expose nothing to scan.
  _resolveExtId(manifest) {
    return typeof manifest.key === "string"
      ? this._extIdFromKey(manifest.key)
      : this._extIdFromPath(this.extDir);
  }

  async launch({ extensionPath, url, headless = false, channel = "chromium", cwd = process.cwd(), onProgress = () => {} }) {
    // No extensionPath = plain website-testing mode (no side-load flags below).
    this.extDir = extensionPath ? resolve(cwd, extensionPath) : null;
    // Kept so cext_reload can relaunch with the same options when it has to.
    this.launchOpts = { extensionPath, headless, channel, cwd };
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
    // Read once: popup() and the ID derivation below both need it.
    this.manifest = this.extDir ? this._readManifest() : {};
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
    if (this.extDir) this.extId = this._resolveExtId(this.manifest);

    await this._ensurePage();
    if (url) await this.open(url);

    const workers = this.context.serviceWorkers();
    return {
      extId: this.extId,
      extDir: this.extDir,
      popupPath: this.manifest.action?.default_popup ?? null,
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
    const ctx = this._ctx();
    const page = newTab ? await ctx.newPage() : await this._ensurePage();
    if (newTab) this.activePage = page;
    await page.goto(url, { waitUntil });
    return this._result(page);
  }

  // Close one page (e.g. the marketing tab an extension opens on install) so it
  // stops confusing active-tab resolution, without tearing down the session.
  async closePage(index) {
    const pages = this._ctx().pages().filter((p) => !p.isClosed());
    const page = index == null ? await this._ensurePage() : pages[index];
    if (!page) throw new Error(`No page at index ${index} (have ${pages.length})`);
    await page.close();
    if (this.activePage === page) this.activePage = null;
    return this._result(await this._ensurePage());
  }

  // Reload the extension after a source edit. A side-loaded unpacked extension
  // never respawns its service worker, so chrome.runtime.reload() leaves every
  // chrome-extension:// URL dead (ERR_BLOCKED_BY_CLIENT): the only reload that
  // leaves a usable extension is a relaunch with the same options. Do that
  // directly instead of waiting for a worker that never comes.
  async reloadExtension() {
    if (!this.launchOpts) throw new NotLaunchedError();
    return this.launch(this.launchOpts);
  }

  // Escape hatch: raw CDP for anything the tool set does not wrap (permissions,
  // Network.*, Emulation.*, …). target: "page" (default) or "browser".
  async cdp(method, params = {}, { target = "page" } = {}) {
    if (typeof method !== "string" || !method.trim()) throw new Error("cdp: method must be a non-empty string");
    if (params == null) params = {};
    if (typeof params !== "object" || Array.isArray(params))
      throw new Error(`cdp params must be an object (got ${typeof params}) — e.g. {"expression":"location.href"}`);
    if (target !== "page" && target !== "browser") throw new Error(`cdp target must be "page" or "browser"`);
    const ctx = this._ctx();
    this._cdp ??= new Map();
    const browser = target === "browser";
    const key = browser ? "browser" : await this._ensurePage();
    let session = this._cdp.get(key);
    if (!session) {
      session = browser ? await ctx.browser().newBrowserCDPSession() : await ctx.newCDPSession(key);
      this._cdp.set(key, session);
    }
    return session.send(method, params);
  }

  async popup() {
    const ctx = this._ctx();
    if (!this.extDir) throw new Error("No extension loaded — launch with extensionPath to test a popup");
    const popupPath = this.manifest?.action?.default_popup;
    if (!popupPath) throw new Error(`No action.default_popup in manifest`);
    const prev = this.activePage && !this.activePage.isClosed() ? this.activePage : null;
    const page = await ctx.newPage();
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
    return this._result(page);
  }

  async switchPage(index) {
    const pages = this._ctx().pages().filter((p) => !p.isClosed());
    const page = pages[index];
    if (!page) throw new Error(`No page at index ${index} (have ${pages.length})`);
    this.activePage = page;
    return this._result(page);
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
  // ponytail: a genuinely missing option therefore costs 2x timeout.
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

  // N interactions in ONE tool call. Each step returns a one-liner (no
  // per-step snapshot), so a 12-step flow is one round trip, not twelve.
  async batch(steps, { snapshot = false, stopOnError = true } = {}) {
    if (!Array.isArray(steps) || steps.length === 0) throw new Error("batch: steps must be a non-empty array");
    const results = [];
    for (const [i, step] of steps.entries()) {
      try {
        results.push({ i, op: step.op, selector: step.selector, ...(await this._batchStep(step)) });
      } catch (e) {
        results.push({ i, op: step.op, selector: step.selector, error: e.message });
        if (stopOnError) break;
      }
    }
    const failed = results.find((r) => r.error);
    return {
      results,
      final: snapshot ? await this._snapshot() : await this._result(await this._ensurePage()),
      stoppedAt: failed && stopOnError ? failed.i : null,
    };
  }

  // Every case returns the one line batch prints for it: { result }.
  async _batchStep(step) {
    const timeout = step.timeout ?? 5000;
    switch (step.op) {
      case "click":
        return this.click(step.selector, { index: step.index ?? 0, timeout }).then(() => ({ result: "ok" }));
      case "fill":
        return this.fill(step.selector, step.value ?? "", { timeout }).then(() => ({ result: "ok" }));
      case "press":
        return this.press(step.selector, step.key, { timeout }).then(() => ({ result: "ok" }));
      case "select":
        return this.select(step.selector, step.value, { timeout }).then(() => ({ result: "ok" }));
      case "hover":
        return this.hover(step.selector, { timeout }).then(() => ({ result: "ok" }));
      case "scroll":
        return this.scroll({ selector: step.selector, to: step.to, x: step.x ?? 0, y: step.y ?? 0, timeout }).then(
          (r) => ({ result: `x=${r.x} y=${r.y}` })
        );
      case "history":
        return this.history(step.direction).then((r) => ({ result: r.url }));
      case "wait":
        return this.wait(step.selector, { timeout, state: step.state ?? "visible", text: step.text }).then((r) => ({
          result: `found: ${r.found}`,
        }));
      case "open":
        return this.open(step.url, {
          newTab: step.newTab ?? false,
          waitUntil: step.waitUntil ?? "domcontentloaded",
        }).then((r) => ({ result: r.url }));
      case "switch":
        return this.switchPage(step.index).then((r) => ({ result: r.url }));
      case "closePage":
        return this.closePage(step.index).then((r) => ({ result: r.url }));
      case "eval":
        return this.eval(step.expression);
      case "screenshot":
        return this.screenshot({
          fullPage: step.fullPage ?? false,
          selector: step.selector,
          inline: step.inline ?? false,
        }).then((shot) => ({ result: shot.path }));
      case "logs":
        return this.logs({ level: step.level, source: step.source, since: step.since ?? 0 }).then((r) => ({
          result:
            `${r.entries.length} entries (next ${r.next})` +
            (r.entries.length
              ? `\n${r.entries.map((e) => `[${e.i}] ${e.source}/${e.level}: ${e.text}`).join("\n")}`
              : ""),
        }));
      case "metrics":
        return this.metrics().then((m) => ({
          result: `dcl ${m.domContentLoaded}ms / load ${m.load}ms / ${(m.bytes / 1024).toFixed(1)} KB / ${m.resources} resources`,
        }));
      default:
        throw new Error(`unknown batch op: ${step.op} (have ${OPS.join("/")})`);
    }
  }

  // Scrolling for its own sake: lazy-loaded / infinite lists, reading or
  // shooting below-the-fold content. Clicks already scroll their own target.
  async scroll({ selector = null, to = null, x = 0, y = 0, timeout = 5000 } = {}) {
    const page = await this._ensurePage();
    if (selector) {
      await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout });
    } else if (to === "bottom") {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    } else if (to === "top") {
      await page.evaluate(() => window.scrollTo(0, 0));
    } else if (x || y) {
      await page.evaluate(([dx, dy]) => window.scrollBy(dx, dy), [x, y]);
    }
    return page.evaluate(() => ({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) }));
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
      // Compact, not 2-space-indented: pretty-printing a 40-object result is
      // ~30% more characters (newlines + indent) for whitespace the model does
      // not read — and eval output is the largest thing a step returns.
      text = JSON.stringify(raw);
    } catch {
      text = String(raw);
    }
    return { result: text.slice(0, MAX_TEXT), type: raw === null ? "null" : typeof raw };
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

  // inline:false (default) returns the path only — a base64 PNG round-trips the
  // whole image through the model's context for no gain in most flows.
  async screenshot({ fullPage = false, selector = undefined, inline = false } = {}) {
    const page = await this._ensurePage();
    const buf = selector
      ? await page.locator(selector).first().screenshot()
      : await page.screenshot({ fullPage });
    const name = `cext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    writeFileSync(join(this.artifactsDir, name), buf);
    return { data: inline ? buf.toString("base64") : null, path: join(this.artifactsDir, name) };
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