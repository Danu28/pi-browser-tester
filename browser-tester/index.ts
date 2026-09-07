// browser-tester — pi extension.
// Registers the cext_* tool family: a real Playwright-driven Chromium the agent
// drives end to end — website testing & browser actions without any extension,
// plus full unpacked-Chrome-extension testing (popup flows, content scripts,
// service workers, screenshots, console logs).
// Core logic lives in src/session.js (no pi imports) so it is provable via
// `npm run check` without pi.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ChromeExtSession, NotLaunchedError, OPS, stepLine } from "./src/session.js";

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

// One cext_batch step. Every op maps to an existing session method; unknown
// keys are ignored by the runner, unknown ops fail the step with a clear list.
const batchStep = Type.Object({
  op: oneOf(OPS, "Operation to run"),
  selector: Type.Optional(selector("Playwright selector (click/fill/press/select/hover/wait/screenshot)")),
  value: Type.Optional(Type.String({ description: "Value for fill, or option value/label for select" })),
  key: Type.Optional(Type.String({ description: "Key for press, e.g. 'Enter' or 'Control+a'" })),
  to: Type.Optional(oneOf(["top", "bottom"], "For scroll: scroll to the top or bottom of the page")),
  x: Type.Optional(Type.Integer({ description: "For scroll: horizontal scroll delta in px" })),
  y: Type.Optional(Type.Integer({ description: "For scroll: vertical scroll delta in px" })),
  direction: Type.Optional(oneOf(["back", "forward"], "For history: which way to navigate")),
  text: Type.Optional(Type.String({ description: "For wait: wait for this visible text instead of a selector" })),
  url: Type.Optional(Type.String({ description: "For open: URL to navigate to" })),
  index: Type.Optional(Type.Integer({ description: "0-based element index for click, or page index for switch/closePage" })),
  expression: Type.Optional(Type.String({ description: "For eval: JS expression or IIFE returning a value" })),
  timeout: ms("Step"),
  state: Type.Optional(oneOf(["visible", "hidden", "attached", "detached"], "For wait: element state (default visible)")),
  newTab: Type.Optional(Type.Boolean({ description: "For open: new tab instead of navigating the active page" })),
  waitUntil: Type.Optional(oneOf(["domcontentloaded", "load", "networkidle"], "For open (default domcontentloaded)")),
  fullPage: Type.Optional(Type.Boolean({ description: "For screenshot: capture the full scrollable page" })),
  inline: Type.Optional(Type.Boolean({ description: "For screenshot: also return the image to the model (default false)" })),
  level: Type.Optional(oneOf(["log", "error", "warning", "debug", "info", "pageerror"], "For logs: level filter")),
  source: Type.Optional(oneOf(["page", "worker", "network", "download", "workerevent"], "For logs: source filter")),
  since: Type.Optional(Type.Integer({ description: "For logs: only entries with index >= since" })),
});

// Result shapes. Most tools return a page snapshot; the rest return plain text.
const snapText = (s: any) =>
  `URL: ${s.url}\nTitle: ${s.title}\nActive page: ${s.activeIndex} of ${
    s.pages.length
  } page(s): ${s.pages.map((p: any) => `[${p.index}] ${p.url}`).join(", ")}\n--- body text ---\n${
    s.bodyText || "(no text)"
  }`;

const snap = (s: any) => ({ content: [{ type: "text", text: snapText(s) }], details: { s } });

// Tool schemas reuse the step fields, so a field is described once.
const pick = (names: string[]) =>
  Type.Object(Object.fromEntries(names.map((n) => [n, batchStep.properties[n]])));

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
      "Launch (or relaunch after edits) a real browser. Pass extensionPath to load an unpacked Chrome extension; omit it for plain website testing. Chromium (~170 MB) downloads automatically on first use.",
    promptSnippet: "Launch a browser (optionally with an unpacked Chrome extension loaded)",
    promptGuidelines: [
      "Use cext_launch before any other cext_* tool. Call it again after the user edits extension code — it tears down and relaunches fresh, which is the reload step.",
      "Website/UI testing: omit extensionPath entirely and drive pages with cext_batch steps (open/click/fill/select/hover/wait/scroll/history/eval/screenshot/logs/metrics); read the page with cext_snapshot.",
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
          description: "Browser channel: 'chromium' (default — Playwright's Chrome for Testing; branded Chrome/Edge 137+ dropped --load-extension)",
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
    name: "cext_popup",
    label: "Open Popup",
    description:
      "Open the extension's action popup (action.default_popup) as a page. The previously active page keeps browser focus, so chrome.tabs.query({active,lastFocusedWindow}) still resolves to the page under test.",
    promptSnippet: "Open the extension popup for UI testing",
    parameters: Type.Object({}),
    run: () => session.popup().then(snap),
  },
  {
    name: "cext_snapshot",
    label: "Snapshot Page",
    description:
      "Current URL, title, open pages and the body text of the active page — the only reader of page text (actions return one line, not the page).",
    promptSnippet: "Read the current page state (URL, title, body text)",
    parameters: Type.Object({}),
    run: () => session.snapshot().then(snap),
  },
  {
    name: "cext_screenshot",
    label: "Screenshot",
    description:
      "Screenshot the active page (or just selector), saved under ./artifacts/. inline:true also returns the image to the model.",
    promptSnippet: "Take a screenshot of the visible page (or an element)",
    parameters: pick(["selector", "fullPage", "inline"]),
    run: (p) =>
      session.screenshot({ fullPage: p.fullPage ?? false, selector: p.selector, inline: p.inline ?? false }).then((shot) => ({
        content: shot.data
          ? [
              { type: "text", text: `screenshot saved: ${shot.path}` },
              // Flat shape is what pi's tool-result pipeline reads; the nested
              // source:{type:"base64"} form is Anthropic's outbound wire format
              // and leaves data undefined here (Buffer.from(undefined) -> throw).
              { type: "image", data: shot.data, mimeType: "image/png" },
            ]
          : [{ type: "text", text: `screenshot saved: ${shot.path} (image not returned — pass inline:true to see it)` }],
        details: { path: shot.path },
      })),
  },
  {
    name: "cext_logs",
    label: "Extension Logs",
    description:
      "Console / page-error / service-worker / network / download entries captured since launch (or since `since`).",
    promptSnippet: "Read browser console and extension service-worker logs",
    parameters: pick(["level", "source", "since"]),
    run: (p) =>
      session.logs({ level: p.level, source: p.source, since: p.since ?? 0 }).then((r) =>
        text(
          `${r.entries.length === 0 ? "(no log entries)" : r.entries.map((e) => `[${e.i}] ${e.source}/${e.level}: ${e.text}`).join("\n")}\n` +
            // details.next is for the human; the model only sees content, so the
            // cursor has to be in the text or `since` is unusable.
            `next: ${r.next} — pass as {since} to skip these entries next time`,
          { next: r.next }
        )
      ),
  },
  {
    name: "cext_serve",
    label: "Serve Fixture Dir",
    description:
      "Serve dir over http://127.0.0.1:<port> for content-script testing — content scripts never run on file:// or data: pages.",
    promptSnippet: "Serve a local folder over http for content-script testing",
    parameters: Type.Object({
      dir: Type.String({ description: "Directory to serve (cwd-relative or absolute)" }),
    }),
    run: (p, ctx) => session.serve(normPath(p.dir), { cwd: ctx.cwd }).then((srv) => text(`serving ${srv.origin}`, { srv })),
  },
  {
    name: "cext_close",
    label: "Close Browser",
    description: "Close the browser and any static server. Logs and state reset on the next cext_launch.",
    promptSnippet: "Shut down the test browser",
    parameters: Type.Object({}),
    run: () => session.close().then(() => text("closed")),
  },
  {
    name: "cext_reload",
    label: "Reload Extension",
    description:
      "Pick up extension source edits: relaunches with the same path and options. Chrome never respawns a side-loaded extension's service worker, so a relaunch is the reload.",
    promptSnippet: "Reload the extension after editing its source",
    parameters: Type.Object({}),
    run: () =>
      session.reloadExtension().then((r) =>
        text(
          `extension reloaded (browser relaunch — a side-loaded extension's service worker never respawns)\nservice workers: ${r.serviceWorkers.join(", ") || "none"}`,
          { r }
        )
      ),
  },
  {
    name: "cext_batch",
    label: "Batch Browser Steps",
    description:
      "Run many browser steps in ONE call — the action surface. Each step (click/fill/press/select/hover/wait/open/switch/closePage/scroll/history/eval/screenshot/logs/metrics) returns one line, so a 12-step flow is one round trip. snapshot:true adds the final page text; stoppedAt names the step that failed.",
    promptSnippet: "Run many browser steps in a single call (cheapest way to drive a flow)",
    promptGuidelines: [
      "cext_batch is the action surface: click/fill/press/select/hover/wait/scroll/history/open/switch/closePage/eval/screenshot/logs/metrics are steps in it, not tools of their own.",
      "End a batch with an {op:'eval'} step returning a compact object of the assertions you care about; that replaces a separate cext_snapshot.",
      "Pass snapshot:true to include the final page body text (default false — one-liners only).",
      "Steps run in order; stopOnError:true (default) stops at the first failure and reports stoppedAt.",
    ],
    parameters: Type.Object({
      steps: Type.Array(batchStep, { description: "Steps to run, in order" }),
      snapshot: Type.Optional(
        Type.Boolean({ description: "Include the final page body text (default false)" })
      ),
      stopOnError: Type.Optional(
        Type.Boolean({ description: "Stop at the first failing step (default true)" })
      ),
    }),
    run: (p) =>
      session.batch(p.steps, { snapshot: p.snapshot ?? false, stopOnError: p.stopOnError ?? true }).then((r) =>
        text(
          `${r.results.map(stepLine).join("\n")}\n--- final ---\n${r.final.url}\n${r.final.title ?? ""}` +
            (r.stoppedAt === null ? "" : `\nstopped at step ${r.stoppedAt}`),
          { r }
        )
      ),
  },
  {
    name: "cext_cdp",
    label: "Raw CDP",
    description:
      "Escape hatch: send a raw CDP command (Network.enable, Browser.grantPermissions, Emulation.*, …) to the active page or the browser.",
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
