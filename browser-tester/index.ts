// browser-tester — pi extension.
// Registers the cext_* tool family: a real Playwright-driven Chromium the agent
// drives end to end — website testing & browser actions without any extension,
// plus full unpacked-Chrome-extension testing (popup flows, content scripts,
// service workers, screenshots, console logs).
// Core logic lives in src/session.js (no pi imports) so it is provable via
// `npm run check` without pi.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ChromeExtSession, NotLaunchedError } from "./src/session.js";

const session = new ChromeExtSession();

// Path arg convention: agents sometimes pass a leading @; strip it (same as built-ins).
const normPath = (p: string) => p.replace(/^@/, "");

// String enums without pulling in @earendil-works/pi-ai at runtime.
const oneOf = (values: string[], description: string) =>
  Type.Union(values.map((v) => Type.Literal(v)), { description });

// Shared param fields.
const ms = (what: string) =>
  Type.Optional(Type.Integer({ description: `${what} timeout in ms (default 5000)` }));
const selector = (description: string) => Type.String({ description });

// Result shapes. Most tools return a page snapshot; the rest return plain text.
const snapText = (s: any) =>
  `URL: ${s.url}\nTitle: ${s.title}\nActive page: ${s.activeIndex} of ${
    s.pages.length
  } page(s): ${s.pages.map((p: any) => `[${p.index}] ${p.url}`).join(", ")}\n--- body text ---\n${
    s.bodyText || "(no text)"
  }`;

const snap = (s: any) => ({ content: [{ type: "text", text: snapText(s) }], details: { s } });
const text = (t: string, details: unknown = {}) => ({ content: [{ type: "text", text: t }], details });

const fail = (e: unknown) =>
  e instanceof NotLaunchedError ? e.message : `cext error: ${(e as Error).message}`;

type Run = (p: any, ctx: { cwd?: string; onUpdate?: any }) => Promise<any>;

// One entry per tool: name/label/description are what the agent sees, `run`
// calls into src/session.js. Adding a tool = adding an entry here.
const tools: {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: any;
  run: Run;
}[] = [
  {
    name: "cext_launch",
    label: "Launch Browser",
    description:
      "Launch (or relaunch after edits) a real browser. Pass extensionPath to load an unpacked Chrome extension for extension testing; omit it to launch a plain browser for website testing — then drive any http(s) page. On first use the bundled Chromium is downloaded automatically (~170 MB, one time).",
    promptSnippet: "Launch a browser (optionally with an unpacked Chrome extension loaded)",
    promptGuidelines: [
      "Use cext_launch before any other cext_* tool. Call it again after the user edits extension code — it tears down and relaunches fresh, which is the reload step.",
      "Website/UI testing: omit extensionPath entirely and just drive pages (cext_open, cext_click, cext_fill, cext_select, cext_hover, cext_wait, cext_snapshot, cext_screenshot, cext_metrics).",
      "Extension testing: pass the absolute or cwd-relative path to the extension folder containing manifest.json, e.g. './sample-extension', then use cext_popup / cext_reload, and cext_serve for content-script flows.",
    ],
    parameters: Type.Object({
      extensionPath: Type.Optional(
        Type.String({
          description: "Path to the unpacked extension folder (contains manifest.json). Omit for plain website testing.",
        })
      ),
      url: Type.Optional(Type.String({ description: "Optional URL to open after launch" })),
      headless: Type.Optional(
        Type.Boolean({ description: "Run without a visible window (default false — unreliable for extensions in real Chrome)" })
      ),
      channel: Type.Optional(
        Type.String({
          description: "Browser channel: 'chromium' (default — Playwright's bundled Chrome for Testing; branded Chrome/Edge 137+ removed --load-extension, so they cannot side-load extensions) or 'chrome'/'msedge' for older browsers that still honor the flags",
        })
      ),
    }),
    run: async (p, ctx) => {
      const info = await session.launch({
        extensionPath: p.extensionPath ? normPath(p.extensionPath) : undefined,
        url: p.url,
        headless: p.headless ?? false,
        channel: p.channel ?? "chromium",
        cwd: ctx.cwd,
        onProgress: (m: string) => ctx.onUpdate?.({ content: [{ type: "text", text: m }] }),
      });
      return text(
        `Launched: ${
          info.extId ? `extension id ${info.extId} (${info.extDir})` : "no extension loaded — plain website-testing mode"
        }\n${info.serviceWorkers.length ? `service workers: ${info.serviceWorkers.join(", ")}` : ""}\npopup: ${info.popupPath ?? "none"}`,
        { info }
      );
    },
  },
  {
    name: "cext_history",
    label: "Browser Back / Forward",
    description:
      "Navigate the active page one step back or forward in its browser history (as clicking the browser's back/forward buttons). Use for form-resubmission and navigation flows.",
    promptSnippet: "Go back or forward in browser history",
    parameters: Type.Object({
      direction: oneOf(["back", "forward"], "Which direction to navigate"),
    }),
    run: (p) => session.history(p.direction).then(snap),
  },
  {
    name: "cext_open",
    label: "Open URL",
    description:
      "Navigate the active page to url. Use for normal web pages, http://127.0.0.1:<port> fixture pages served by cext_serve, or extension pages like chrome-extension://<id>/options.html.",
    promptSnippet: "Navigate the browser to a URL",
    parameters: Type.Object({
      url: Type.String({ description: "URL to open" }),
      newTab: Type.Optional(
        Type.Boolean({ description: "Open in a new tab instead of navigating the active page (default false)" })
      ),
      waitUntil: Type.Optional(
        oneOf(["domcontentloaded", "load", "networkidle"], "When to consider navigation done (default domcontentloaded; use networkidle for SPAs)")
      ),
    }),
    run: (p) => session.open(p.url, { newTab: p.newTab ?? false, waitUntil: p.waitUntil ?? "domcontentloaded" }).then(snap),
  },
  {
    name: "cext_popup",
    label: "Open Popup",
    description:
      "Open the extension's action popup (from action.default_popup in manifest.json) as a page and make it the active page. The previously active page keeps browser focus, so the extension still resolves chrome.tabs.query({active,lastFocusedWindow}) to the page under test. Use after cext_launch to test popup UI.",
    promptSnippet: "Open the extension popup for UI testing",
    parameters: Type.Object({}),
    run: () => session.popup().then(snap),
  },
  {
    name: "cext_snapshot",
    label: "Snapshot Page",
    description:
      "Return current URL, title, list of open pages, and the visible body text of the active page. Call after any action to see the page state.",
    promptSnippet: "Read the current page state (URL, title, body text)",
    parameters: Type.Object({}),
    run: () => session.snapshot().then(snap),
  },
  {
    name: "cext_metrics",
    label: "Page Performance Metrics",
    description:
      "Return load-performance metrics of the active page: DOMContentLoaded / load timing (ms after navigation start), total transferred bytes, and resource counts by type. Use after navigation to assert pages are healthy (reasonable weight, no stragglers).",
    promptSnippet: "Measure page load performance (timings, resource counts)",
    parameters: Type.Object({}),
    run: () =>
      session.metrics().then((m) =>
        text(
          `URL: ${m.url}\nDOMContentLoaded: ${m.domContentLoaded ?? "n/a"} ms\nload: ${m.load ?? "n/a"} ms\ntransferred: ${(m.bytes / 1024).toFixed(1)} KB\nresources: ${m.resources}\nby type: ${JSON.stringify(m.byType)}`,
          { m }
        )
      ),
  },
  {
    name: "cext_switch",
    label: "Switch Page",
    description:
      "Make the page at index the active page (indices as listed by cext_snapshot / cext_open). Useful after cext_popup created a second page.",
    promptSnippet: "Switch the active page by index",
    parameters: Type.Object({
      index: Type.Integer({ description: "Page index from the pages list" }),
    }),
    run: (p) => session.switchPage(p.index).then(snap),
  },
  {
    name: "cext_click",
    label: "Click Element",
    description:
      "Click the first element matching selector (any Playwright selector: '#id', '.cls', 'text=...', 'role=button[name=...]'). Returns the resulting page snapshot.",
    promptSnippet: "Click an element by CSS/text/role selector",
    parameters: Type.Object({
      selector: selector("Playwright selector, e.g. '#increment' or 'text=Save'"),
      index: Type.Optional(Type.Integer({ description: "0-based index of the element to click when multiple match" })),
      timeout: ms("Click"),
    }),
    run: (p) => session.click(p.selector, { index: p.index ?? 0, timeout: p.timeout ?? 5000 }).then(snap),
  },
  {
    name: "cext_fill",
    label: "Fill Input",
    description: "Fill the first input matching selector with value.",
    promptSnippet: "Type into an input field",
    parameters: Type.Object({
      selector: selector("Playwright selector for the input"),
      value: Type.String({ description: "Text to type" }),
      timeout: ms("Fill"),
    }),
    run: (p) => session.fill(p.selector, p.value, { timeout: p.timeout ?? 5000 }).then(snap),
  },
  {
    name: "cext_hover",
    label: "Hover Element",
    description:
      "Move the mouse over the first element matching selector — reveals hover-only menus, dropdowns and tooltips before you click into them.",
    promptSnippet: "Hover an element (menus, tooltips)",
    parameters: Type.Object({
      selector: selector("Playwright selector, e.g. '.nav-item' or 'text=Profile'"),
      timeout: ms("Hover"),
    }),
    run: (p) => session.hover(p.selector, { timeout: p.timeout ?? 5000 }).then(snap),
  },
  {
    name: "cext_select",
    label: "Select Option",
    description: "Choose an option in the first <select> matching selector — pass the option's value or its visible label.",
    promptSnippet: "Choose an option from a dropdown select",
    parameters: Type.Object({
      selector: selector("Playwright selector for the <select>"),
      value: Type.String({ description: "Option value or visible label to select" }),
      timeout: ms("Select"),
    }),
    run: (p) => session.select(p.selector, p.value, { timeout: p.timeout ?? 5000 }).then(snap),
  },
  {
    name: "cext_press",
    label: "Press Key",
    description:
      "Press a key or shortcut — globally on the page, or (with selector) after focusing that element. Keys: 'Tab', 'Enter', 'Escape', 'ArrowDown', 'Control+a', ... Essential for keyboard-only and accessibility flows.",
    promptSnippet: "Press a keyboard key (Tab, Enter, Escape, …)",
    parameters: Type.Object({
      key: Type.String({ description: "Key or shortcut, e.g. 'Tab', 'Enter', 'Escape', 'Control+a'" }),
      selector: Type.Optional(Type.String({ description: "Focus this element first (default: press globally)" })),
      timeout: ms("Focus/press"),
    }),
    run: (p) => session.press(p.selector, p.key, { timeout: p.timeout ?? 5000 }).then(snap),
  },
  {
    name: "cext_eval",
    label: "Evaluate JS",
    description:
      "Evaluate a JavaScript expression in the active page and return the JSON-serialized result. Use an expression or an IIFE that returns a value, e.g. \"document.querySelector('#count').textContent\" or \"(() => { const r = []; ...; return r; })()\".",
    promptSnippet: "Run JavaScript in the page and get the result",
    parameters: Type.Object({
      expression: Type.String({ description: "JS expression or IIFE to evaluate" }),
    }),
    run: (p) =>
      session.eval(p.expression).then((r) => text(`result (${r.type}):\n${r.result}`, { r })),
  },
  {
    name: "cext_wait",
    label: "Wait For Element",
    description:
      "Wait up to timeout ms for a selector (or for text to appear). Returns { found: true/false } — non-throwing, so use it for assertions like 'wait until the popup shows \"Tests complete\"'. Pass state:'hidden' to wait for something to disappear (e.g. a spinner).",
    promptSnippet: "Wait for an element or text to appear (assertion)",
    parameters: Type.Object({
      selector: Type.Optional(selector("Playwright selector (omit when waiting on text)")),
      text: Type.Optional(Type.String({ description: "Wait for this visible text instead of a selector" })),
      state: Type.Optional(
        oneOf(["visible", "hidden", "attached", "detached"], "Element state to wait for (default visible)")
      ),
      timeout: Type.Optional(Type.Integer({ description: "Milliseconds to wait (default 5000)" })),
    }),
    run: (p) =>
      session
        .wait(p.selector, { timeout: p.timeout ?? 5000, state: p.state ?? "visible", text: p.text })
        .then((r) => text(`found: ${r.found}`, { r })),
  },
  {
    name: "cext_screenshot",
    label: "Screenshot",
    description:
      "Screenshot the active page (or just the element matching selector). The image is returned to the model and also saved under ./artifacts/.",
    promptSnippet: "Take a screenshot of the visible page (or an element)",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "Screenshot only this element instead of the whole page" })),
      fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page (default false)" })),
    }),
    run: (p) =>
      session.screenshot({ fullPage: p.fullPage ?? false, selector: p.selector }).then((shot) => ({
        content: [
          { type: "text", text: `screenshot saved: ${shot.path}` },
          // Flat shape is what pi's tool-result pipeline reads; the nested
          // source:{type:"base64"} form is Anthropic's outbound wire format and
          // leaves data undefined here (Buffer.from(undefined) -> throw).
          { type: "image", data: shot.data, mimeType: "image/png" },
        ],
        details: { path: shot.path },
      })),
  },
  {
    name: "cext_logs",
    label: "Extension Logs",
    description:
      "Return console / page-error / service-worker log entries captured since launch (or since `since`). Levels: log, error, warning, debug, info, pageerror.",
    promptSnippet: "Read browser console and extension service-worker logs",
    parameters: Type.Object({
      level: Type.Optional(oneOf(["log", "error", "warning", "debug", "info", "pageerror"], "Level to filter by")),
      source: Type.Optional(
        oneOf(["page", "worker", "network", "download", "workerevent"], "Filter by source: page console, extension service worker, network failures/4xx-5xx, downloads")
      ),
      since: Type.Optional(Type.Integer({ description: "Only entries with index >= since (from the previous call's next)" })),
    }),
    run: (p) =>
      session.logs({ level: p.level, source: p.source, since: p.since ?? 0 }).then((r) =>
        text(
          r.entries.length === 0
            ? "(no log entries)"
            : r.entries.map((e) => `[${e.i}] ${e.source}/${e.level}: ${e.text}`).join("\n"),
          { next: r.next }
        )
      ),
  },
  {
    name: "cext_serve",
    label: "Serve Fixture Dir",
    description:
      "Start (or restart) an ephemeral static http server for dir, returning its origin (http://127.0.0.1:<port>). Use to host local fixture pages so extension content scripts (matched on http/https) inject into them — file:// and data: pages do NOT run content scripts.",
    promptSnippet: "Serve a local folder over http for content-script testing",
    parameters: Type.Object({
      dir: Type.String({ description: "Directory to serve (cwd-relative or absolute)" }),
    }),
    run: (p, ctx) => session.serve(normPath(p.dir), { cwd: ctx.cwd }).then((srv) => text(`serving ${srv.origin}`, { srv })),
  },
  {
    name: "cext_close",
    label: "Close Browser",
    description: "Close the browser and any static server. Session state (including logs) is reset on the next cext_launch.",
    promptSnippet: "Shut down the test browser",
    parameters: Type.Object({}),
    run: () => session.close().then(() => text("closed")),
  },
  {
    name: "cext_close_page",
    label: "Close Page",
    description:
      "Close one page (default: the active page, or the page at index) without closing the browser. Use to get rid of tabs the extension opened itself (onboarding/marketing tabs) so they stop confusing active-tab resolution.",
    promptSnippet: "Close a tab",
    parameters: Type.Object({
      index: Type.Optional(Type.Integer({ description: "Page index from the pages list (default: active page)" })),
    }),
    run: (p) => session.closePage(p.index).then(snap),
  },
  {
    name: "cext_reload",
    label: "Reload Extension",
    description:
      "Reload the loaded extension (chrome.runtime.reload()) without relaunching the browser — the fast way to pick up source edits. Falls back to a full browser relaunch when no service worker respawns (Chrome does not respawn one for a side-loaded unpacked extension), so the extension is always usable afterwards.",
    promptSnippet: "Reload the extension after editing its source",
    parameters: Type.Object({}),
    run: () =>
      session.reloadExtension().then((r) =>
        text(
          `extension reloaded${r.fallback ? " (via browser relaunch — no service worker respawned)" : ""}\nservice workers: ${r.serviceWorkers.join(", ") || "none"}`,
          { r }
        )
      ),
  },
  {
    name: "cext_cdp",
    label: "Raw CDP",
    description:
      "Escape hatch: send a raw Chrome DevTools Protocol command (Network.enable, Browser.grantPermissions, Emulation.*, Page.captureScreenshot, …) to the active page or the browser. Use for anything the cext_* tools do not wrap.",
    promptSnippet: "Send a raw CDP command",
    parameters: Type.Object({
      method: Type.String({ description: "CDP method, e.g. 'Network.enable' or 'Browser.grantPermissions'" }),
      params: Type.Optional(Type.Any({ description: "CDP params object" })),
      target: Type.Optional(oneOf(["page", "browser"], "Send to the active page (default) or the browser")),
    }),
    run: (p) =>
      session.cdp(p.method, p.params ?? {}, { target: p.target ?? "page" }).then((r) =>
        text(`${p.method} → ${JSON.stringify(r) ?? "(no result)"}`, { r })
      ),
  },
];

export default function browserTester(pi: ExtensionAPI) {
  // pi runs sibling tool calls from one assistant message concurrently, so every
  // cext_* op goes through a single chain and cannot race the browser.
  let busy = Promise.resolve();
  const serial = (fn: () => Promise<any>) => {
    const run = busy.then(fn, fn);
    busy = run.catch(() => {});
    return run;
  };

  for (const def of tools) {
    pi.registerTool({
      name: def.name,
      label: def.label,
      description: def.description,
      promptSnippet: def.promptSnippet,
      promptGuidelines: def.promptGuidelines,
      parameters: def.parameters,
      async execute(_toolCallId, params, _signal, onUpdate, ctx) {
        try {
          return await serial(() => def.run(params, { cwd: ctx.cwd, onUpdate }));
        } catch (e) {
          // throw => tool marked isError and reported to the LLM
          throw new Error(fail(e));
        }
      },
    });
  }

  pi.on("session_shutdown", async () => {
    await session.close().catch(() => {});
  });
}
