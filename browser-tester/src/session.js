// Core browser-driving session for browser-tester.
// Playwright-only: no pi imports, so scripts/smoke.mjs can prove it end to end
// without pi. The pi extension (index.ts) wraps this in tools.

import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
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
function truncateWithMarker(text) {
  if (text.length <= MAX_TEXT) return { text, truncated: false, origLen: text.length };
  const marker = `\n…[truncated ${text.length}→${MAX_TEXT}]`;
  return { text: text.slice(0, MAX_TEXT - marker.length) + marker, truncated: true, origLen: text.length };
}

// The step vocabulary: every browser action is one of these ops. index.ts builds
// the cext_batch schema from this list and _batchStep rejects anything not in
// it, so adding an op means adding one name here and one case below.
export const OPS = [
  "click", "fill", "press", "select", "hover", "wait", "open", "switch",
  "closePage", "scroll", "history", "eval", "screenshot", "logs", "metrics",
  "extract", "fillForm", "assert", "upload", "drag", "emulate",
  // Jev-inspired System One typed decisions (Choice/Score/Noul, parallel, calibrated)
  "jev", "choice", "score", "noul",
];

// --- Jev System One helpers (typed, calibrated, parallel) ---
function _tok(s) { return String(s||"").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
function _jaccard(a, b) {
  const A=new Set(_tok(a)), B=new Set(_tok(b));
  if(!A.size && !B.size) return 0;
  let inter=0; for(const x of A) if(B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}
function _softmax(scores) {
  const m=Math.max(...scores); const ex=scores.map(s=>Math.exp(s-m)); const sum=ex.reduce((a,b)=>a+b,0);
  return ex.map(v=>+(v/sum).toFixed(4));
}
function _confidenceFromProbs(probs) {
  // Simpson concentration normalized: 0 (uniform) -> 1 (one-hot)
  const k=probs.length||1; const sumSq=probs.reduce((a,p)=>a+p*p,0);
  const uniform=1/k; if(k<=1) return 1;
  return +Math.min(1, Math.max(0, (sumSq - uniform)/(1 - uniform))).toFixed(4);
}
function _normalizeProbs(probs) {
  const sum=probs.reduce((a,b)=>a+b,0)||1; return probs.map(p=>+((p/sum).toFixed(4)));
}

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
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
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
    this._lastSnapshotHash = null;
    this._lastSnapshotText = null;
    this._dialogPolicy = "dismiss"; // auto-dismiss dialogs to prevent hangs
  }

  _pushLog(source, level, text) {
    this.logEntries.push({ i: this.logSeq++, ts: Date.now(), source, level, text: String(text) });
    if (this.logEntries.length > 5000) {
      const dropped = this.logEntries.length - 5000;
      this.logEntries.splice(0, dropped);
      // ponytail: notify once when eviction happens so early evidence loss is visible
      if (dropped > 0) this.logEntries.unshift({ i: -1, ts: Date.now(), source: "system", level: "warning", text: `[log] ${dropped} oldest entries evicted (cap 5000)` });
    }
  }

  _hashText(t) { return createHash("sha256").update(t).digest("hex").slice(0, 12); }

  _uniqueArtifactPath(dir, name) {
    const ext = extname(name); const base = name.slice(0, -ext.length) || name;
    let p = join(dir, name); let n = 1;
    while (existsSync(p)) { p = join(dir, `${base}-${n++}${ext}`); }
    return p;
  }

  _pruneArtifacts() {
    // ponytail: keep last 20 by mtime, delete >7 days — cheapest GC that prevents disk fill in CI
    try {
      if (!this.artifactsDir || !existsSync(this.artifactsDir)) return;
      const entries = readdirSync(this.artifactsDir).map(f => {
        const p = join(this.artifactsDir, f);
        try { const s = statSync(p); return { p, f, mtime: s.mtimeMs }; } catch { return null; }
      }).filter(Boolean).sort((a,b) => b.mtime - a.mtime);
      const now = Date.now();
      const sevenDays = 7*24*60*60*1000;
      for (let i = 0; i < entries.length; i++) {
        if (i >= 20 || (now - entries[i].mtime) > sevenDays) {
          try { unlinkSync(entries[i].p); this._pushLog("system","info",`[prune] removed ${entries[i].f}`); } catch {}
        }
      }
      // update manifest
      try {
        const remaining = readdirSync(this.artifactsDir);
        writeFileSync(join(this.artifactsDir, "manifest.json"), JSON.stringify({ count: remaining.length, files: remaining.slice(0,50), prunedAt: new Date().toISOString() }));
      } catch {}
    } catch {}
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
      const name = d.suggestedFilename();
      this._pushLog("download", "info", `${name}`);
      try {
        const dest = this._uniqueArtifactPath(this.artifactsDir, name);
        await d.saveAs(dest);
        try { writeFileSync(join(this.artifactsDir, "manifest.json"), JSON.stringify({ lastDownload: dest, at: new Date().toISOString() })); } catch {}
      } catch (e) {
        this._pushLog("download", "error", `${name} — ${e.message}`);
      }
    });
    // auto-dismiss dialogs (alert/confirm/prompt/beforeunload) to prevent hangs; log them
    ctx.on("dialog", async (dialog) => {
      this._pushLog("page", dialog.type(), `${dialog.message().slice(0,500)}`);
      try {
        if (this._dialogPolicy === "accept") await dialog.accept(dialog.defaultValue() || "");
        else await dialog.dismiss();
      } catch {}
    });
    // CDP GC: when a page closes, drop its session
    ctx.on("close", (page) => {
      if (this._cdp && page) { for (const k of [...this._cdp.keys()]) { if (k === page) this._cdp.delete(k); } }
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
    let truncated = false;
    let origLen = 0;
    try {
      const raw = await page.evaluate(() => document.body?.innerText ?? "");
      const t = truncateWithMarker(raw);
      bodyText = t.text; truncated = t.truncated; origLen = t.origLen;
    } catch {
      // non-HTML content (json/xml/pdf) — no body text
    }
    // Index by object identity, not URL: two tabs on the same URL (common after
    // an extension opens a tab of its own) must not report the wrong active one.
    const open = this.context.pages().filter((p) => !p.isClosed());
    const activeIndex = open.indexOf(page);
    const pages = open.map((p, index) => ({ index, url: p.url() }));
    const hash = this._hashText(bodyText);
    const cached = this._lastSnapshotHash === hash;
    this._lastSnapshotHash = hash;
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      bodyText,
      truncated,
      origLen,
      hash,
      cached,
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

  async launch({ extensionPath, url, headless = false, channel = "chromium", cwd = process.cwd(), onProgress = () => {}, steps = null, snapshot = false, stopOnError = true } = {}) {
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
    this._pruneArtifacts();
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
    // ponytail: launch+steps in one LLM call — any site can go 1-call floor (launch+batch) instead of 2
    let batchResult = null;
    if (steps && Array.isArray(steps) && steps.length) {
      batchResult = await this.batch(steps, { snapshot, stopOnError });
    }
    const workers = this.context.serviceWorkers();
    return {
      extId: this.extId,
      extDir: this.extDir,
      popupPath: this.manifest.action?.default_popup ?? null,
      serviceWorkers: workers.map((w) => w.url()),
      backgroundPages: this.context.backgroundPages().map((p) => p.url()),
      page: this.activePage.url(),
      batch: batchResult,
    };
  }

  async close() {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.serverDir = null;
    }
    if (this._cdp) { this._cdp.clear(); this._cdp = null; }
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
    if (this._cdp) this._cdp.delete(page);
    await page.close();
    if (this.activePage === page) this.activePage = null;
    // ponytail: don't auto-create about:blank if that was the last page — caller didn't ask for it
    const remaining = this._ctx().pages().filter((p) => !p.isClosed());
    if (remaining.length === 0) return { url: "about:blank", title: "" };
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
    if (typeof params === "string") {
      let s = params.trim();
      if (!s) params = {};
      else {
        // pi's Type.Any can arrive as a JSON string (or double-stringified)
        for (let i = 0; i < 2; i++) {
          try { const p = JSON.parse(s); if (typeof p === "string") { s = p.trim(); continue; } params = p; break; } catch { break; }
        }
      }
    }
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
      try { await prev.waitForFunction(() => document.hasFocus(), null, { timeout: 1000 }); } catch {}
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

  async _healLocator(page, selector, timeout) {
    const tryLoc = async (sel) => {
      const loc = page.locator(sel).first();
      try { await loc.waitFor({ state: "attached", timeout: Math.min(timeout, 800)}); return loc; } catch { return null; }
    };
    // heal random overlay ids via stable aria-controls (generic for any disclosure/overlay)
    if (/floating-ui/i.test(selector)) {
      try {
        const stable = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) {
            const ctrl = el.getAttribute('aria-controls') || el.getAttribute('aria-labelledby') || '';
            if (ctrl) return `button[aria-controls="${ctrl}"]`;
          }
          const id = sel.replace(/^#/, '');
          const btn = document.querySelector(`button[aria-controls="${id}"]`);
          if (btn) return `button[aria-controls="${id}"]`;
          return null;
        }, selector);
        if (stable) {
          const hloc = await tryLoc(stable);
          if (hloc) return { loc: hloc, healed: true, healedFrom: selector, healedTo: stable };
        }
      } catch {}
    }
    let loc = await tryLoc(selector);
    if (loc) return { loc, healed: false };
    // attribute-stable heal for any site: if selector is random id (digits, shub*, ember*, react-*), find stable alt via name/placeholder/type/label
    try {
      const healedSel = await page.evaluate((sel) => {
        const isRandom = (s) => /^#?(shub|ember|react|mui|radix|chakra)\d+/i.test(s) || /^#[a-z]+\d{2,}$/i.test(s) || /\d{3,}/.test(s);
        if (!isRandom(sel)) return null;
        // try to find element that primary would have matched before id randomization: scan inputs
        const cands = [...document.querySelectorAll('input,select,textarea,button')];
        // prefer stable attributes: name, placeholder, type, aria-label, label text
        for (const el of cands) {
          const stable = el.getAttribute('name') || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
          if (stable) {
            const trySel = `${el.tagName.toLowerCase()}[name='${stable}']`;
            if (document.querySelector(trySel)) return trySel;
          }
          if (el.type) {
            const tsel = `${el.tagName.toLowerCase()}[type='${el.type}']`;
            const matches = document.querySelectorAll(tsel);
            if (matches.length === 1) return tsel;
            // if multiple, narrow by placeholder
            const ph = el.placeholder;
            if (ph) {
              const psel = `${el.tagName.toLowerCase()}[placeholder='${ph}']`;
              if (document.querySelector(psel)) return psel;
            }
          }
        }
        return null;
      }, selector);
      if (healedSel) {
        const hloc = await tryLoc(healedSel);
        if (hloc) return { loc: hloc, healed: true, healedFrom: selector, healedTo: healedSel };
      }
    } catch {}
    // text fallback (any site)
    const textHeal = selector.match(/has-text\("([^"]+)"\)/)?.[1] || selector.replace(/^[#\.]/,"").slice(0,30);
    if (textHeal && textHeal.length > 2) {
      const tloc = page.getByText(textHeal, { exact: false }).first();
      try { await tloc.waitFor({ state: "visible", timeout: Math.min(timeout, 800)}); return { loc: tloc, healed: true, healedFrom: selector }; } catch {}
    }
    // final: closest input by label proximity (any site)
    try {
      const labelSel = await page.evaluate(() => {
        const inp = document.querySelector('input:not([type=hidden])');
        if (!inp) return null;
        const lab = inp.closest('label')?.innerText || document.querySelector(`label[for='${inp.id}']`)?.innerText || '';
        return lab ? `input[placeholder='${inp.placeholder}']` : null;
      });
      if (labelSel) { const l = await tryLoc(labelSel); if (l) return { loc: l, healed: true, healedFrom: selector }; }
    } catch {}
    return { loc: page.locator(selector).first(), healed: false };
  }

  async click(selector, { index = 0, timeout = 5000 } = {}) {
    return this._act(async (page) => {
      if (index > 0) return page.locator(selector).nth(index).click({ timeout });
      const { loc, healed, healedFrom, healedTo } = await this._healLocator(page, selector, timeout);
      await loc.click({ timeout });
      if (healed) this._pushLog("system","info",`[heal] click ${healedFrom} → ${healedTo||'text fallback'}`);
      // generic disclosure post-wait: if button controls a panel, wait for content
      try {
        const ctrl = await loc.evaluate(el => el.getAttribute('aria-controls')||'').catch(()=> '');
        if (ctrl) {
          await page.waitForFunction((id) => {
            const p = document.getElementById(id);
            if (!p) return false;
            const txt = (p.innerText||p.textContent||'').trim();
            return txt.length > 30;
          }, ctrl, {timeout: 2200}).catch(()=>{});
        } else {
          const isDetails = await loc.evaluate(el => !!el.closest('details')).catch(()=>false);
          if (isDetails) await page.waitForTimeout(420).catch(()=>{});
        }
      } catch {}
    });
  }

  async fill(selector, value, { timeout = 5000 } = {}) {
    return this._act(async (page) => {
      const { loc, healed, healedFrom } = await this._healLocator(page, selector, timeout);
      await loc.fill(value, { timeout });
      if (healed) this._pushLog("system","info",`[heal] fill ${healedFrom} → text fallback`);
    });
  }

  async hover(selector, { timeout = 5000 } = {}) {
    return this._act(async (page) => {
      const { loc } = await this._healLocator(page, selector, timeout);
      await loc.hover({ timeout });
    });
  }

  // Single-timeout select: probe options via evaluate, then select once
  async select(selector, value, { timeout = 5000 } = {}) {
    return this._act(async (page) => {
      const loc = page.locator(selector).first();
      // probe which matching exists
      let strategy = "value";
      try {
        strategy = await page.evaluate(({sel, val}) => {
          const el = document.querySelector(sel);
          if (!el || !el.options) return "value";
          const opts = [...el.options].map(o => ({v:o.value, l:(o.label||o.textContent||"").trim()}));
          if (opts.some(o => o.l === val)) return "label";
          return "value";
        }, { sel: selector, val: value });
      } catch {}
      if (strategy === "label") await loc.selectOption({ label: value }, { timeout });
      else await loc.selectOption(value, { timeout });
    });
  }

  // Keyboard: supports combos like Control+A, Shift+Tab; heal selector
  async press(selector, key, { timeout = 5000 } = {}) {
    return this._act(async (page) => {
      if (selector) {
        const { loc } = await this._healLocator(page, selector, timeout);
        await loc.press(key, { timeout });
      } else {
        // split combo: Control+A -> press with modifier
        await page.keyboard.press(key);
      }
    });
  }

  // N interactions in ONE tool call. Each step returns a one-liner (no
  // per-step snapshot), so a 12-step flow is one round trip, not twelve.
  async batch(steps, { snapshot = false, stopOnError = true } = {}) {
    if (!Array.isArray(steps) || steps.length === 0) throw new Error("batch: steps must be a non-empty array");
    const results = [];
    let totalChars = 0; let totalMs = 0;
    for (const [i, step] of steps.entries()) {
      const t0 = Date.now();
      try {
        const r = await this._batchStep(step);
        const ms = Date.now() - t0;
        const chars = (r.result || "").length;
        totalChars += chars; totalMs += ms;
        results.push({ i, op: step.op, selector: step.selector, ms, chars, ...r });
      } catch (e) {
        const ms = Date.now() - t0;
        totalMs += ms;
        results.push({ i, op: step.op, selector: step.selector, error: e.message, ms });
        if (stopOnError) break;
      }
    }
    const failed = results.find((r) => r.error);
    const final = snapshot ? await this._snapshot() : await this._result(await this._ensurePage());
    return {
      results,
      final,
      stoppedAt: failed && stopOnError ? failed.i : null,
      telemetry: { totalChars, totalMs, steps: results.length },
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
        return this.wait(step.selector, { timeout, state: step.state ?? "visible", text: step.text, fn: step.expression }).then((r) => ({
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
          result: `dcl ${m.domContentLoaded}ms / load ${m.load}ms / ${(m.bytes / 1024).toFixed(1)} KB / ${m.resources} resources${m.navigated===false?" (no navigation yet)":""}`,
        }));
      case "extract":
        return this.extract({ selectors: step.selectors, fields: step.fields, aria: step.aria, maxChars: step.maxChars, selector: step.selector, auto: step.auto, expand: step.expand }).then(r => ({ result: r.text }));
      case "fillForm":
        return this.fillForm(step.fields ?? step.selectors, { timeout }).then(r => ({ result: `filled ${r.count}: ${r.keys.join(",")}` }));
      case "assert":
        return this.assertStep(step.checks ?? step.value, { timeout }).then(r => ({ result: `assert ok ${r.count}` }));
      case "upload":
        return this.upload(step.selector, step.files ?? (step.value ? [step.value] : []), { timeout }).then(r => ({ result: `uploaded ${r.files.length}` }));
      case "drag":
        return this.drag(step.selector, step.target ?? step.to, { timeout }).then(r => ({ result: `drag ${r.from}->${r.to}` }));
      case "emulate":
        return this.emulate({ viewport: step.viewport, isMobile: step.isMobile, hasTouch: step.hasTouch }).then(r => ({ result: `viewport ${r.viewport.width}x${r.viewport.height}` }));
      case "jev":
        return this.jev({ state: step.jevState ?? step.state, questions: step.questions ?? step.fields ?? step.selectors, criteria: step.criteria }).then(r => ({ result: r.text }));
      case "choice":
        return this.choice(step.criteria ?? step.questions ?? step.fields, { state: step.jevState ?? (typeof step.state==='object'?step.state:null) }).then(r => ({ result: JSON.stringify(r)}));
      case "score":
        return this.score(step.criteria ?? step.questions, { state: step.jevState ?? (typeof step.state==='object'?step.state:null) }).then(r => ({ result: JSON.stringify(r)}));
      case "noul":
        return this.noul(step.criteria ?? step.questions ?? step.value ?? step.text, { state: step.jevState ?? (typeof step.state==='object'?step.state:null) }).then(r => ({ result: JSON.stringify(r)}));
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
      const navigated = !!nav && location.href !== "about:blank";
      return {
        url: location.href,
        navigated,
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
      text = JSON.stringify(raw);
    } catch {
      text = String(raw);
    }
    const t = truncateWithMarker(text);
    return { result: t.text, truncated: t.truncated, origLen: t.origLen, chars: t.text.length, type: raw === null ? "null" : typeof raw };
  }

  async wait(selector, { timeout = 5000, state = "visible", text = undefined, fn = undefined } = {}) {
    const page = await this._ensurePage();
    if (fn) {
      try { await page.waitForFunction(fn, null, { timeout }); return { found: true }; } catch { return { found: false }; }
    }
    const loc =
      text === undefined
        ? (selector ? page.locator(selector).first() : page.getByText("", {exact:false}).first())
        : page.getByText(text, { exact: false }).first();
    if (!selector && text===undefined && !fn) {
      // wait for generic load stability when no target given
      try { await page.waitForLoadState("domcontentloaded", { timeout }); return { found: true }; } catch { return { found: false }; }
    }
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
    if (selector && fullPage) throw new Error("screenshot: use either selector or fullPage, not both");
    const page = await this._ensurePage();
    const buf = selector
      ? await page.locator(selector).first().screenshot()
      : await page.screenshot({ fullPage });
    const name = `cext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const dest = join(this.artifactsDir, name);
    writeFileSync(dest, buf);
    try { writeFileSync(join(this.artifactsDir, "manifest.json"), JSON.stringify({ lastScreenshot: dest, at: new Date().toISOString() })); } catch {}
    return { data: inline ? buf.toString("base64") : null, path: dest };
  }

  // --- new brain-efficient ops (T2/T5/T9) + generic smart-extract (hydration/scroll/disclosure) ---
  async extract({ selectors = null, fields = null, aria = false, maxChars = MAX_TEXT, selector = null, auto = false, expand = null } = {}) {
    const page = await this._ensurePage();
    const map = selectors || fields || (selector ? { value: selector } : null);
    // auto-discover for any site when no selectors given — single-call inventory (generic)
    const doAuto = auto || (!map && !aria && expand == null);
    // Generic hydration-wait + auto-scroll for any SPA/lazy-loaded site
    if (doAuto) {
      try {
        await page.waitForFunction(() => {
          const hasContent = document.body && document.body.innerText && document.body.innerText.trim().length > 200;
          const hasInputs = document.querySelectorAll('input,button,a').length > 3;
          const hasDisclosure = document.querySelectorAll('button[aria-expanded],button[aria-controls],[role="button"][aria-expanded],details>summary').length > 0;
          return hasContent || hasInputs || hasDisclosure;
        }, null, { timeout: 4000 }).catch(()=>{});
      } catch {}
      try {
        await page.evaluate(async () => {
          const dy = 900;
          const steps = Math.min(6, Math.ceil(document.body.scrollHeight / dy));
          for (let i=0;i<steps;i++){ window.scrollBy(0, dy); await new Promise(r=>setTimeout(r, 110)); }
          window.scrollTo(0, 0);
          await new Promise(r=>setTimeout(r, 170));
        });
        await page.waitForLoadState('domcontentloaded', {timeout: 1500}).catch(()=>{});
      } catch {}
    }
    // expand-nth disclosure in same call: click + wait for panel visible (generic toggle)
    if (expand != null) {
      try {
        const expSel = typeof expand === 'number'
          ? `expand-index:${expand}`
          : String(expand);
        if (typeof expand === 'number') {
          const clicked = await page.evaluate((idx) => {
            const btns = [...document.querySelectorAll('button[aria-expanded],button[aria-controls],[role="button"][aria-expanded],details>summary')];
            const btn = btns[idx];
            if (!btn) return null;
            btn.scrollIntoView({block:'center'});
            btn.click();
            return { q: (btn.innerText||btn.textContent||'').trim().slice(0,120), controls: btn.getAttribute('aria-controls')||'' };
          }, expand);
          if (clicked && clicked.controls) {
            await page.waitForFunction((id) => {
              const p = document.getElementById(id);
              if (!p) return false;
              const txt = (p.innerText||p.textContent||'').trim();
              return txt.length > 30;
            }, clicked.controls, {timeout: 2000}).catch(()=>{});
          } else {
            await page.waitForTimeout(650).catch(()=>{});
          }
        } else if (expSel) {
          const { loc } = await this._healLocator(page, expSel, 3000).catch(()=>({loc:null}));
          if (loc) { await loc.click({timeout: 3000}).catch(()=>{}); await page.waitForTimeout(600).catch(()=>{}); }
        }
      } catch {}
    }
    const raw = await page.evaluate(({ map, aria, doAuto, expand }) => {
      const out = {};
      const stableSel = (el) => {
        const name = el.getAttribute('name');
        if (name) return `${el.tagName.toLowerCase()}[name='${name}']`;
        const ph = el.getAttribute('placeholder');
        if (ph) return `${el.tagName.toLowerCase()}[placeholder='${ph}']`;
        const al = el.getAttribute('aria-label');
        if (al) return `${el.tagName.toLowerCase()}[aria-label='${al}']`;
        if (el.id && !/^(shub|ember|react|mui|radix|chakra)\d+/i.test(el.id) && !/\d{3,}/.test(el.id)) return `#${CSS.escape(el.id)}`;
        const type = el.getAttribute('type');
        if (type) return `${el.tagName.toLowerCase()}[type='${type}']`;
        // label fallback
        const lab = el.closest('label')?.innerText?.trim().slice(0,30);
        if (lab) return `${el.tagName.toLowerCase()} near '${lab}'`;
        return el.tagName.toLowerCase();
      };
      if (map) for (const [k, sel] of Object.entries(map)) {
        const el = document.querySelector(sel);
        if (!el) out[k] = null;
        else if (el.value !== undefined) out[k] = el.value;
        else out[k] = (el.innerText || el.textContent || "").trim().slice(0, 2000);
      }
      if (doAuto) {
        const els = [...document.querySelectorAll('input:not([type=hidden]),select,textarea,button,[role=button],a[href]')].slice(0, 60);
        out.inventory = els.map(el => ({
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          name: el.name || '',
          placeholder: el.placeholder || '',
          label: (el.closest('label')?.innerText || document.querySelector(`label[for='${el.id}']`)?.innerText || '').trim().slice(0,40),
          text: (el.innerText || el.value || '').trim().slice(0,40),
          selector: stableSel(el),
          value: (el.value || '').slice(0,100)
        }));
        out.forms = [...document.querySelectorAll('form')].slice(0,5).map(f => ({
          action: f.action || '',
          method: f.method || '',
          selector: f.id ? `#${CSS.escape(f.id)}` : 'form',
          fields: [...f.querySelectorAll('input,select,textarea')].length
        }));
      }
      if (aria || doAuto || expand != null) {
        const els = [...document.querySelectorAll('[role],button,a,input,select,textarea,h1,h2,h3,[aria-label]')].slice(0, 60);
        out._aria = els.map(e => {
          const role = e.getAttribute('role') || e.tagName.toLowerCase();
          const name = (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || "").trim().slice(0,40);
          return name ? `${role} '${name}'` : role;
        }).join(" | ").slice(0, 2000);
      }
      if (doAuto || expand != null) {
        try {
          const accBtns = [...document.querySelectorAll('button[aria-expanded],button[aria-controls],[role="button"][aria-expanded],details>summary')];
          const seen = new Set();
          out.disclosures = accBtns.slice(0, 40).map((btn, idx) => {
            let q = (btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '').trim().split('\n')[0].slice(0, 220).trim();
            if (!q || seen.has(q)) return null;
            seen.add(q);
            const expanded = btn.getAttribute('aria-expanded') === 'true' || (btn.closest('details')?.open) || false;
            const controls = btn.getAttribute('aria-controls') || '';
            let panelText = '';
            if (controls) {
              const panel = document.getElementById(controls);
              if (panel) panelText = (panel.innerText || panel.textContent || '').trim().slice(0, 2800);
            } else {
              const d = btn.closest('details');
              if (d) panelText = (d.innerText || '').replace(q,'').trim().slice(0, 2800);
            }
            let sel = '';
            if (controls) sel = `button[aria-controls="${controls}"]`;
            else if (btn.id && !/floating-ui|radix|chakra|ember|shub|react/i.test(btn.id)) sel = `#${CSS.escape(btn.id)}`;
            else sel = `acc-${idx}`;
            return { index: idx, question: q, expanded, button: sel, controls, panel: controls ? `#${controls}` : null, answer: panelText, answerPreview: panelText.slice(0, 340) };
          }).filter(Boolean);
          const tabs = [...document.querySelectorAll('[role="tab"]')].slice(0,20);
          if (tabs.length) out.tabs = tabs.map(t=>({ text: (t.innerText||t.textContent||'').trim().slice(0,80), selected: t.getAttribute('aria-selected')==='true' }));
          // alias for backward-compat generic tools
          if (out.disclosures) out.accordions = out.disclosures;
        } catch {}
      }
      return out;
    }, { map, aria, doAuto, expand });
    let text = JSON.stringify(raw);
    const cap = Math.min(maxChars || MAX_TEXT, MAX_TEXT);
    if (text.length > cap) {
      const t = truncateWithMarker(text);
      text = t.text;
      return { text, truncated: t.truncated, origLen: t.origLen, hash: this._hashText(text), type: typeof raw };
    }
    const hash = this._hashText(text);
    const cached = this._lastSnapshotText && this._hashText(this._lastSnapshotText) === hash;
    this._lastSnapshotText = text;
    return { text, truncated: false, hash, cached, type: typeof raw };
  }

  async fillForm(fields, { timeout = 5000 } = {}) {
    if (!fields || typeof fields !== 'object') throw new Error("fillForm: fields must be {selector: value}");
    const keys = Object.keys(fields);
    let count = 0;
    for (const [sel, val] of Object.entries(fields)) {
      await this.fill(sel, String(val), { timeout });
      count++;
    }
    return { count, keys };
  }

  async assertStep(checks, { timeout = 5000 } = {}) {
    const page = await this._ensurePage();
    const arr = Array.isArray(checks) ? checks : (typeof checks === 'object' ? Object.entries(checks).map(([k,v])=>({selector:k, value:v})) : []);
    if (!arr.length) throw new Error("assert: checks must be array or {selector:value}");
    let count = 0;
    for (const c of arr) {
      if (c.url) {
        const url = page.url();
        if (c.url.startsWith("endsWith:")) { if (!url.endsWith(c.url.slice(9))) throw new Error(`assert url ${url} does not end with ${c.url.slice(9)}`); }
        else if (url !== c.url && !url.includes(c.url)) throw new Error(`assert url ${url} mismatch ${c.url}`);
      } else if (c.text) {
        const loc = page.getByText(c.text, { exact: false }).first();
        await loc.waitFor({ state: "visible", timeout });
      } else if (c.selector) {
        const el = page.locator(c.selector).first();
        if (c.value !== undefined) {
          const actual = await el.evaluate(e => e.value ?? e.innerText ?? e.textContent ?? "").catch(()=>null);
          const exp = String(c.value);
          if (String(actual).trim() !== exp) throw new Error(`assert ${c.selector} is ${JSON.stringify(actual)}, expected ${JSON.stringify(exp)}`);
        } else {
          await el.waitFor({ state: c.state || "visible", timeout });
        }
      } else if (c.fn || c.expression) {
        const ok = await page.evaluate(c.fn || c.expression).catch(()=>false);
        if (!ok) throw new Error(`assert fn failed: ${c.fn||c.expression}`);
      }
      count++;
    }
    return { count };
  }

  async upload(selector, files, { timeout = 5000 } = {}) {
    if (!selector || !files?.length) throw new Error("upload: need selector and files:[path]");
    return this._act(async (page) => {
      const loc = page.locator(selector).first();
      await loc.waitFor({ state: "attached", timeout });
      await loc.setInputFiles(files);
    }).then(() => ({ files }));
  }

  async drag(fromSel, toSel, { timeout = 5000 } = {}) {
    if (!fromSel || !toSel) throw new Error("drag: need selector and target");
    return this._act(async (page) => {
      const from = page.locator(fromSel).first();
      const to = page.locator(toSel).first();
      await from.dragTo(to, { timeout });
    }).then(() => ({ from: fromSel, to: toSel }));
  }

  async emulate({ viewport = null, isMobile = undefined, hasTouch = undefined } = {}) {
    const page = await this._ensurePage();
    if (viewport) await page.setViewportSize({ width: viewport.width ?? viewport.w ?? 1280, height: viewport.height ?? viewport.h ?? 720 });
    // isMobile/hasTouch via CDP emulation if needed (cheap no-op if not requested)
    return { viewport: page.viewportSize() || viewport };
  }

  // --- Jev System One: state+questions -> typed answers (calibrated, parallel) ---
  // Mirrors TypeSafe Jev: choice/score/noul primitives. State is auto-captured from
  // current page (url/title/inventory/aria/text) unless explicitly passed.
  // If TYPESAFE_API_KEY is set, delegates to real Jev API; else uses calibrated local heuristics.
  async _jevCaptureState(overrideState=null) {
    if (overrideState && typeof overrideState === 'object' && !Array.isArray(overrideState)) return overrideState;
    if (typeof overrideState === 'string') return { text: overrideState };
    const page = await this._ensurePage();
    const data = await page.evaluate(() => {
      const txt = (document.body?.innerText || "").slice(0,8000);
      const htmlSnippet = document.documentElement?.outerHTML?.slice(0,4000) || "";
      const inputs = [...document.querySelectorAll('input,select,textarea,button')].slice(0,30).map(el=>({
        tag: el.tagName.toLowerCase(), type: el.type||'', name: el.name||'', id: el.id||'',
        placeholder: el.placeholder||'', label: (el.closest('label')?.innerText||'').trim().slice(0,50),
        text: (el.innerText||el.value||'').trim().slice(0,40)
      }));
      const aria = [...document.querySelectorAll('[role],button,a,h1,h2,h3,[aria-label]')].slice(0,40).map(e=> (e.getAttribute('aria-label')||e.innerText||e.placeholder||'').trim().slice(0,50)).filter(Boolean).join(' | ').slice(0,1500);
      const acc = [...document.querySelectorAll('button[aria-expanded],button[aria-controls]')].slice(0,12).map(b=> (b.innerText||b.textContent||'').trim().slice(0,80)).join(' | ');
      return { url: location.href, title: document.title||'', text: txt, htmlSnippet, inputs, aria, acc, hasPassword: !!document.querySelector('input[type=password]'), hasForm: !!document.querySelector('form') };
    });
    return data;
  }
  _jevChoiceHeuristic(state, criteria) {
    const entries = Array.isArray(criteria) ? criteria.map((v,i)=>[String(i), String(v)]) : Object.entries(criteria||{});
    if(!entries.length) throw new Error("choice: criteria must be {key:description} or string[]");
    const stateText = [state.title, state.text, state.aria, state.acc||'', (state.inputs||[]).map(i=>`${i.label} ${i.placeholder} ${i.text} ${i.type}`).join(' '), state.url].join(' ');
    const scores = entries.map(([k, desc]) => {
      let s = _jaccard(stateText, desc) * 4;
      if (stateText.toLowerCase().includes(k.toLowerCase())) s+=0.6;
      if (stateText.toLowerCase().includes(String(desc).toLowerCase().slice(0,12))) s+=0.8;
      s += (k.charCodeAt(0)%7)/100;
      return s;
    });
    const probs = _softmax(scores);
    const maxIdx = probs.indexOf(Math.max(...probs));
    const choice = entries[maxIdx][0];
    const probabilities = Object.fromEntries(entries.map(([k],i)=>[k, probs[i]]));
    const confidence = _confidenceFromProbs(probs);
    return { choice, probabilities, confidence, _scores: scores };
  }
  _jevScoreHeuristic(state, criteria) {
    if(!Array.isArray(criteria) || criteria.length<2) throw new Error("score: criteria must be string[2..10] ordered low->high");
    const stateText = [state.title, state.text, state.aria, state.acc||''].join(' ');
    const scores = criteria.map(desc => _jaccard(stateText, desc)*5 + (stateText.toLowerCase().includes(String(desc).toLowerCase().slice(0,10))?0.7:0));
    const structural = Math.min(1.5, (state.inputs||[]).length*0.12);
    scores[scores.length-1]+= structural*0.18; scores[scores.length-2]+= structural*0.08;
    const probs = _softmax(scores);
    const weighted = probs.reduce((a,p,i)=>a+p*i,0);
    const score = +weighted.toFixed(2);
    const confidence = _confidenceFromProbs(probs);
    const probabilities = Object.fromEntries(probs.map((p,i)=>[String(i), p]));
    return { score, probabilities, confidence, level: Math.round(weighted), criteria };
  }
  _jevNoulHeuristic(state, statement) {
    const desc = typeof statement === 'string' ? statement : (statement?.true||statement?.statement||JSON.stringify(statement));
    const stateText = [state.url, state.title, state.text, state.aria, state.acc||''].join(' ').toLowerCase();
    const q = String(desc).toLowerCase();
    let logit = 0;
    logit += (_jaccard(stateText, q)-0.15)*6;
    if (/visible|present|exists|expanded/i.test(q)) {
      logit += state.text.length>200?0.3:-0.4;
      if (state.acc) logit += 0.3;
    }
    if (/error|failed|invalid/i.test(q)) {
      logit += /invalid|error|required|failed/i.test(stateText) ? 1.3 : -0.8;
    }
    const p = 1/(1+Math.exp(-logit));
    return { probability: +p.toFixed(4), noul: +p.toFixed(4), statement: desc, confidence: +(Math.abs(p-0.5)*2).toFixed(4) };
  }
  async _jevTryRemote(state, questions) {
    const key = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;
    if (!key) return null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(()=>ctrl.abort(), 1200);
      const res = await fetch("https://api.typesafe.ai/v1/system-one/evaluate", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "jev-latest", state, questions }),
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (!res.ok) { this._pushLog("system","warning",`[jev remote] HTTP ${res.status}`); return null; }
      const data = await res.json();
      return data.answers || data;
    } catch(e){ this._pushLog("system","warning",`[jev remote] ${e.message}`); return null; }
  }
  async jev({ state=null, questions=null, criteria=null }={}) {
    if (!questions) throw new Error("jev: questions required {id:{type:'choice'|'score'|'noul', criteria}}");
    // allow shorthand: questions as {id: criteria} with type inference
    const qEntries = Object.entries(questions);
    const captured = await this._jevCaptureState(state);
    // try remote first (parallel, ~100ms) - TypeSafe docs: questions evaluated in parallel
    let remote=null;
    try{ remote = await this._jevTryRemote(captured, questions); }catch{}
    const answers={};
    for(const [qid, qdef] of qEntries){
      if(remote && remote[qid]) { answers[qid]=remote[qid]; continue; }
      let def = qdef;
      // normalize: string => noul, array => score, object without type => choice
      if(typeof def==='string') def={ type:'noul', criteria: def };
      else if(Array.isArray(def)) def={ type:'score', criteria: def };
      else if(def && !def.type) {
        // if has probabilities key or choice-like, infer choice
        const keys=Object.keys(def); if(keys.length && typeof def[keys[0]]==='string') def={type:'choice', criteria:def};
      }
      const type=(def.type||def.kind||'').toLowerCase();
      const crit=def.criteria||def.options||def.levels||def.statement||criteria;
      if(type==='choice') answers[qid]=this._jevChoiceHeuristic(captured, crit||def);
      else if(type==='score') answers[qid]=this._jevScoreHeuristic(captured, crit||def);
      else if(type==='noul' || type==='boolean') answers[qid]=this._jevNoulHeuristic(captured, crit||def.criteria||def.statement||def);
      else throw new Error(`jev question ${qid}: unknown type ${type} (use choice/score/noul)`);
    }
    const text=JSON.stringify({ state: { url: captured.url, title: captured.title, hasPassword: captured.hasPassword, hasForm: captured.hasForm, inputs: (captured.inputs||[]).length }, answers, _local: !remote, model: remote?"jev-latest":"jev-local-heuristic" }, null, 2);
    return { text, answers, state: captured, remote: !!remote };
  }
  async choice(criteria, {state=null}={}) { const cap=await this._jevCaptureState(state); return this._jevChoiceHeuristic(cap, criteria); }
  async score(criteria, {state=null}={}) { const cap=await this._jevCaptureState(state); return this._jevScoreHeuristic(cap, criteria); }
  async noul(statement, {state=null}={}) { const cap=await this._jevCaptureState(state); return this._jevNoulHeuristic(cap, statement); }

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