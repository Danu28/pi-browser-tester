// browser-extension-tester — pi extension.
// Registers the cext_* tool family: load any unpacked Chrome extension into a
// real Playwright-driven Chromium and drive it end to end from the agent.
// Core logic lives in src/session.js (no pi imports) so it is provable via
// `npm run check` without pi.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { ChromeExtSession, NotLaunchedError } from "../src/session.js";

const snapText = (s) =>
  `URL: ${s.url}\nTitle: ${s.title}\nActive page: ${s.activeIndex} of ${
    s.pages.length
  } page(s): ${s.pages.map((p) => `[${p.index}] ${p.url}`).join(", ")}\n--- body text ---\n${
    s.bodyText || "(no text)"
  }`;

const fail = (e) =>
  e instanceof NotLaunchedError ? e.message : `cext error: ${e.message}`;

export default function chromeExtensionTester(pi: ExtensionAPI) {
  const session = new ChromeExtSession();

  // pi runs sibling tool calls from one assistant message concurrently, so every
  // cext_* op goes through a single chain and cannot race the browser.
  let busy = Promise.resolve();
  const serial = (fn) => {
    const run = busy.then(fn, fn);
    busy = run.catch(() => {});
    return run;
  };

  // Path arg convention: agents sometimes pass a leading @; strip it (same as built-ins).
  const normPath = (p: string) => p.replace(/^@/, "");

  const tool = (def: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: any;
    execute: (params: any, ctx: { cwd?: string; onUpdate?: any }) => Promise<{ content: any[]; details: any }>;
  }) => {
    pi.registerTool({
      name: def.name,
      label: def.label,
      description: def.description,
      promptSnippet: def.promptSnippet,
      promptGuidelines: def.promptGuidelines,
      parameters: def.parameters,
      async execute(_toolCallId, params, _signal, onUpdate, ctx) {
        try {
          return await serial(() => def.execute(params, { cwd: ctx.cwd, onUpdate }));
        } catch (e) {
          // throw => tool marked isError and reported to the LLM
          throw new Error(fail(e));
        }
      },
    });
  };

  tool({
    name: "cext_launch",
    label: "Launch Chrome Extension",
    description:
      "Launch (or relaunch after edits) a browser with the unpacked Chrome extension at extensionPath loaded. On first use the bundled Chromium is downloaded automatically (~170 MB, one time). Create a popup flow afterwards with cext_popup, or test content scripts on a page via cext_serve + cext_open.",
    promptSnippet: "Launch a browser with an unpacked Chrome extension loaded",
    promptGuidelines: [
      "Use cext_launch before any other cext_* tool. Call it again after the user edits extension code — it tears down and relaunches fresh, which is the reload step.",
      "Pass the absolute or cwd-relative path to the extension folder containing manifest.json, e.g. './sample-extension'.",
    ],
    parameters: Type.Object({
      extensionPath: Type.String({
        description: "Path to the unpacked extension folder (contains manifest.json)",
      }),
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
    async execute(params, ctx) {
      const info = await session.launch({
        extensionPath: normPath(params.extensionPath),
        url: params.url,
        headless: params.headless ?? false,
        channel: params.channel ?? "chromium",
        cwd: ctx.cwd,
        onProgress: (m) => ctx.onUpdate?.({ content: [{ type: "text", text: m }] }),
      });
      return {
        content: [
          {
            type: "text",
            text: `Launched with extension id ${info.extId} (${info.extDir})\n${
              info.serviceWorkers.length
                ? `service workers: ${info.serviceWorkers.join(", ")}`
                : "no service worker (MV2 background page or no background)"
            }\npopup: ${info.popupPath ?? "none"}`,
          },
        ],
        details: { info },
      };
    },
  });

  tool({
    name: "cext_open",
    label: "Open URL",
    description:
      "Navigate the active page to url. Use for normal web pages, http://127.0.0.1:<port> fixture pages served by cext_serve, or extension pages like chrome-extension://<id>/options.html.",
    promptSnippet: "Navigate the browser to a URL",
    parameters: Type.Object({
      url: Type.String({ description: "URL to open" }),
    }),
    execute: (p) => session.open(p.url).then((s) => ({ content: [{ type: "text", text: snapText(s) }], details: { s } })),
  });

  tool({
    name: "cext_popup",
    label: "Open Popup",
    description:
      "Open the extension's action popup (from action.default_popup in manifest.json) as a page and make it the active page. Use after cext_launch to test popup UI.",
    promptSnippet: "Open the extension popup for UI testing",
    parameters: Type.Object({}),
    execute: () => session.popup().then((s) => ({ content: [{ type: "text", text: snapText(s) }], details: { s } })),
  });

  tool({
    name: "cext_snapshot",
    label: "Snapshot Page",
    description:
      "Return current URL, title, list of open pages, and the visible body text of the active page. Call after any action to see the page state.",
    promptSnippet: "Read the current page state (URL, title, body text)",
    parameters: Type.Object({}),
    execute: () => session.snapshot().then((s) => ({ content: [{ type: "text", text: snapText(s) }], details: { s } })),
  });

  tool({
    name: "cext_switch",
    label: "Switch Page",
    description:
      "Make the page at index the active page (indices as listed by cext_snapshot / cext_open). Useful after cext_popup created a second page.",
    promptSnippet: "Switch the active page by index",
    parameters: Type.Object({
      index: Type.Integer({ description: "Page index from the pages list" }),
    }),
    execute: (p) => session.switchPage(p.index).then((s) => ({ content: [{ type: "text", text: snapText(s) }], details: { s } })),
  });

  tool({
    name: "cext_click",
    label: "Click Element",
    description:
      "Click the first element matching selector (any Playwright selector: '#id', '.cls', 'text=...', 'role=button[name=...]'). Returns the resulting page snapshot.",
    promptSnippet: "Click an element by CSS/text/role selector",
    parameters: Type.Object({
      selector: Type.String({ description: "Playwright selector, e.g. '#increment' or 'text=Save'" }),
      index: Type.Optional(Type.Integer({ description: "0-based index of the element to click when multiple match" })),
    }),
    execute: (p) => session.click(p.selector, { index: p.index ?? 0 }).then((s) => ({ content: [{ type: "text", text: snapText(s) }], details: { s } })),
  });

  tool({
    name: "cext_fill",
    label: "Fill Input",
    description: "Fill the first input matching selector with value.",
    promptSnippet: "Type into an input field",
    parameters: Type.Object({
      selector: Type.String({ description: "Playwright selector for the input" }),
      value: Type.String({ description: "Text to type" }),
    }),
    execute: (p) => session.fill(p.selector, p.value).then((s) => ({ content: [{ type: "text", text: snapText(s) }], details: { s } })),
  });

  tool({
    name: "cext_eval",
    label: "Evaluate JS",
    description:
      "Evaluate a JavaScript expression in the active page and return the JSON-serialized result. Use an expression or an IIFE that returns a value, e.g. \"document.querySelector('#count').textContent\" or \"(() => { const r = []; ...; return r; })()\".",
    promptSnippet: "Run JavaScript in the page and get the result",
    parameters: Type.Object({
      expression: Type.String({ description: "JS expression or IIFE to evaluate" }),
    }),
    execute: (p) =>
      session.eval(p.expression).then((r) => ({
        content: [
          {
            type: "text",
            text: `result (${r.type}):\n${r.result}`,
          },
        ],
        details: { r },
      })),
  });

  tool({
    name: "cext_wait",
    label: "Wait For Element",
    description:
      "Wait up to timeout ms for the first element matching selector to be visible. Returns { found: true/false } — non-throwing, so use it for assertions like 'wait until the popup shows the updated value'.",
    promptSnippet: "Wait for an element to appear (assertion)",
    parameters: Type.Object({
      selector: Type.String({ description: "Playwright selector" }),
      timeout: Type.Optional(Type.Integer({ description: "Milliseconds to wait (default 5000)" })),
    }),
    execute: (p) => session.wait(p.selector, { timeout: p.timeout ?? 5000 }).then((r) => ({ content: [{ type: "text", text: `found: ${r.found}` }], details: { r } })),
  });

  tool({
    name: "cext_screenshot",
    label: "Screenshot",
    description:
      "Screenshot the active page. The image is returned to the model and also saved under ./artifacts/.",
    promptSnippet: "Take a screenshot of the visible page",
    parameters: Type.Object({
      fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page (default false)" })),
    }),
    execute: (p) =>
      session.screenshot({ fullPage: p.fullPage ?? false }).then((shot) => ({
        content: [
          { type: "text", text: `screenshot saved: ${shot.path}` },
          { type: "image", source: { type: "base64", mediaType: "image/png", data: shot.data } },
        ],
        details: { path: shot.path },
      })),
  });

  tool({
    name: "cext_logs",
    label: "Extension Logs",
    description:
      "Return console / page-error / service-worker log entries captured since launch (or since `since`). Levels: log, error, warning, debug, info, pageerror.",
    promptSnippet: "Read browser console and extension service-worker logs",
    parameters: Type.Object({
      level: Type.Optional(StringEnum(["log", "error", "warning", "debug", "info", "pageerror"])),
      since: Type.Optional(Type.Integer({ description: "Only entries with index >= since (from the previous call's next)" })),
    }),
    execute: (p) =>
      session.logs({ level: p.level, since: p.since ?? 0 }).then((r) => ({
        content: [
          {
            type: "text",
            text:
              r.entries.length === 0
                ? "(no log entries)"
                : r.entries.map((e) => `[${e.i}] ${e.source}/${e.level}: ${e.text}`).join("\n"),
          },
        ],
        details: { next: r.next },
      })),
  });

  tool({
    name: "cext_serve",
    label: "Serve Fixture Dir",
    description:
      "Start (or restart) an ephemeral static http server for dir, returning its origin (http://127.0.0.1:<port>). Use to host local fixture pages so extension content scripts (matched on http/https) inject into them — file:// and data: pages do NOT run content scripts.",
    promptSnippet: "Serve a local folder over http for content-script testing",
    parameters: Type.Object({
      dir: Type.String({ description: "Directory to serve (cwd-relative or absolute)" }),
    }),
    execute: (p, ctx) =>
      session.serve(normPath(p.dir), { cwd: ctx.cwd }).then((srv) => ({
        content: [{ type: "text", text: `serving ${srv.origin}` }],
        details: { srv },
      })),
  });

  tool({
    name: "cext_close",
    label: "Close Browser",
    description: "Close the browser and any static server. Session state (including logs) is reset on the next cext_launch.",
    promptSnippet: "Shut down the test browser",
    parameters: Type.Object({}),
    execute: () => session.close().then(() => ({ content: [{ type: "text", text: "closed" }], details: {} })),
  });

  pi.on("session_shutdown", async () => {
    await session.close().catch(() => {});
  });
}