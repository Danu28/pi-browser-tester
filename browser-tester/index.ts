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
  Type.Optional(Type.Integer({ description: "Timeout in ms (default 5000)" }));
const selector = (description: string) => Type.String({ description });

// One cext_batch step. Every op maps to an existing session method; unknown
// keys are ignored by the runner, unknown ops fail the step with a clear list.
const batchStep = Type.Object({
  op: oneOf(OPS, "Operation"),
  selector: Type.Optional(selector("Playwright selector")),
  value: Type.Optional(Type.String({ description: "Value for fill/select" })),
  key: Type.Optional(Type.String({ description: "Key for press (e.g. Enter)" })),
  to: Type.Optional(oneOf(["top", "bottom"], "Scroll target")),
  x: Type.Optional(Type.Integer({ description: "Horizontal scroll delta in px" })),
  y: Type.Optional(Type.Integer({ description: "Vertical scroll delta in px" })),
  direction: Type.Optional(oneOf(["back", "forward"], "History direction")),
  text: Type.Optional(Type.String({ description: "Text to wait for" })),
  url: Type.Optional(Type.String({ description: "URL to open" })),
  index: Type.Optional(Type.Integer({ description: "Element or page index" })),
  expression: Type.Optional(Type.String({ description: "JS expression or IIFE for eval" })),
  timeout: ms("Step"),
  state: Type.Optional(oneOf(["visible", "hidden", "attached", "detached"], "Wait state")),
  newTab: Type.Optional(Type.Boolean({ description: "Open in new tab" })),
  waitUntil: Type.Optional(oneOf(["domcontentloaded", "load", "networkidle"], "Wait until")),
  fullPage: Type.Optional(Type.Boolean({ description: "Capture full page" })),
  inline: Type.Optional(Type.Boolean({ description: "Also return image (default false)" })),
  level: Type.Optional(oneOf(["log", "error", "warning", "debug", "info", "pageerror"], "Log level")),
  source: Type.Optional(oneOf(["page", "worker", "network", "download", "workerevent"], "Log source")),
  since: Type.Optional(Type.Integer({ description: "Start index for logs" })),
  // brain-efficient new ops — all batch-only, no new tool
  selectors: Type.Optional(Type.Any({ description: "Map {key:css} for extract {op:'extract', selectors:{email:'#e'}} or fillForm {op:'fillForm', fields:{'#a':'v'}}" })),
  fields: Type.Optional(Type.Any({ description: "Alias for selectors in fillForm" })),
  checks: Type.Optional(Type.Any({ description: "Array for assert {op:'assert', checks:[{selector,value},{text},{url}]}" })),
  files: Type.Optional(Type.Array(Type.String({ description: "File paths for upload" }))),
  target: Type.Optional(Type.String({ description: "Target selector for drag" })),
  viewport: Type.Optional(Type.Any({ description: "Viewport {width,height} or {w,h} for emulate" })),
  isMobile: Type.Optional(Type.Boolean({ description: "isMobile for emulate" })),
  hasTouch: Type.Optional(Type.Boolean({ description: "hasTouch for emulate" })),
  aria: Type.Optional(Type.Boolean({ description: "Include pruned aria snapshot in extract" })),
  maxChars: Type.Optional(Type.Integer({ description: "Cap for extract result" })),
  auto: Type.Optional(Type.Boolean({ description: "Auto-discover inventory for any site (no selectors needed)" })),
  expand: Type.Optional(Type.Any({ description: "For extract: toggle nth disclosure before capture (number 0-based index or selector string) — expands collapsed content in same call" })),
  // Jev System One typed questions (state-override uses jevState to avoid clash with wait 'state')
  questions: Type.Optional(Type.Any({ description: "Jev questions map {id:{type:'choice'|'score'|'noul', criteria}} or shorthand {id: {key:desc}}" })),
  criteria: Type.Optional(Type.Any({ description: "Criteria for choice ({key:desc})/score ([levels])/noul (statement string)" })),
  jevState: Type.Optional(Type.Any({ description: "Override state for Jev (string or object); auto-captured from page if omitted" })),
});

// Result shapes. Most tools return a page snapshot; the rest return plain text.
const snapText = (s: any) =>
  `URL: ${s.url}\nTitle: ${s.title}\nActive page: ${s.activeIndex} of ${
    s.pages.length
  } page(s): ${s.pages.map((p: any) => `[${p.index}] ${p.url}`).join(", ")}${s.truncated ? ` [truncated ${s.origLen}→${(s.bodyText||"").length}]` : ""}${s.cached ? ` [cached ${s.hash}]` : ""}\n--- body text ---\n${
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
      "Launch a real browser. Pass extensionPath for extension testing; omit for plain website testing. Chromium auto-downloads if missing.",
    promptSnippet: "Launch a browser, optionally with an extension",
    promptGuidelines: [
      "Use cext_launch before any other cext_* tool. Call it again after edits — it tears down and relaunches fresh.",
      "Website testing: omit extensionPath and drive pages with cext_batch. For minimum LLM calls on any site, pass steps in launch: {url, steps:[{op:'extract',auto:true},{op:'fillForm',fields:{...}},{op:'assert',checks:[...]}]} — 1 call instead of launch+batch (2).",
      "Extension testing: pass path to unpacked extension folder (with manifest.json), e.g. './sample-extension', then use cext_popup / cext_reload and cext_serve.",
    ],
    parameters: Type.Object({
      extensionPath: Type.Optional(
        Type.String({
          description: "Unpacked extension path (with manifest.json).",
        })
      ),
      url: Type.Optional(Type.String({ description: "URL to open after launch" })),
      headless: Type.Optional(
        Type.Boolean({ description: "Headless mode (default false)" })
      ),
      channel: Type.Optional(
        Type.String({
          description: "Browser channel (default chromium)",
        })
      ),
      steps: Type.Optional(Type.Array(batchStep, { description: "Optional batch steps to run right after launch — saves 1 LLM call for any site (launch+act in one)" })),
      snapshot: Type.Optional(Type.Boolean({ description: "Include body text with steps (default false)" })),
      stopOnError: Type.Optional(Type.Boolean({ description: "Stop at first failure (default true)" })),
    }),
    run: async (p, ctx) => {
      const info: any = await session.launch({
        extensionPath: p.extensionPath ? normPath(p.extensionPath) : undefined,
        url: p.url,
        headless: p.headless ?? false,
        channel: p.channel ?? "chromium",
        cwd: ctx.cwd,
        onProgress: (m: string) => ctx.onUpdate?.({ content: [{ type: "text", text: m }] }),
        steps: p.steps,
        snapshot: p.snapshot ?? false,
        stopOnError: p.stopOnError ?? true,
      });
      const batchPart = info.batch ? `\n--- batch (${info.batch.results.length} steps) ---\n${info.batch.results.map(stepLine).join("\n")}${info.batch.telemetry ? `\n[telemetry] ${info.batch.telemetry.totalMs}ms ${info.batch.telemetry.totalChars} chars` : ""}${info.batch.stoppedAt!==null?`\nstopped at ${info.batch.stoppedAt}`:""}` : "";
      return text(
        `Launched: ${
          info.extId ? `extension id ${info.extId} (${info.extDir})` : "no extension loaded — plain website-testing mode"
        }\n${info.serviceWorkers.length ? `service workers: ${info.serviceWorkers.join(", ")}` : ""}\npopup: ${info.popupPath ?? "none"}\npage: ${info.page}${batchPart}`,
        { info }
      );
    },
  },
  {
    name: "cext_popup",
    label: "Open Popup",
    description:
      "Open the extension popup as a page. Keeps focus on previous page so tabs.query resolves correctly.",
    promptSnippet: "Open the extension popup",
    parameters: Type.Object({}),
    run: () => session.popup().then(snap),
  },
  {
    name: "cext_snapshot",
    label: "Snapshot Page",
    description:
      "Page URL, title, open pages and body text — the only reader of body text. Prefer extract in batch for pruned aria/selectors (cheaper).",
    promptSnippet: "Read page URL, title and body text",
    parameters: Type.Object({}),
    run: () => session.snapshot().then(snap),
  },
  {
    name: "cext_screenshot",
    label: "Screenshot",
    description:
      "Screenshot page or one element to ./artifacts/. Add inline:true to return the image.",
    promptSnippet: "Screenshot the page or an element",
    parameters: pick(["selector", "fullPage", "inline"]),
    run: (p) =>
      session.screenshot({ fullPage: p.fullPage ?? false, selector: p.selector, inline: p.inline ?? false }).then((shot) => ({
        content: shot.data
          ? [
              { type: "text", text: `screenshot saved: ${shot.path}` },
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
      "Console, page-error, worker, network and download logs since launch.",
    promptSnippet: "Read console and extension logs",
    parameters: pick(["level", "source", "since"]),
    run: (p) =>
      session.logs({ level: p.level, source: p.source, since: p.since ?? 0 }).then((r) =>
        text(
          `${r.entries.length === 0 ? "(no log entries)" : r.entries.map((e) => `[${e.i}] ${e.source}/${e.level}: ${e.text}`).join("\n")}\n` +
            `next: ${r.next} — pass as {since} to skip these entries next time`,
          { next: r.next }
        )
      ),
  },
  {
    name: "cext_serve",
    label: "Serve Fixture Dir",
    description:
      "Serve a local folder over http://127.0.0.1 for content-script testing.",
    promptSnippet: "Serve a local folder for content scripts",
    parameters: Type.Object({
      dir: Type.String({ description: "Directory to serve" }),
    }),
    run: (p, ctx) => session.serve(normPath(p.dir), { cwd: ctx.cwd }).then((srv) => text(`serving ${srv.origin}`, { srv })),
  },
  {
    name: "cext_close",
    label: "Close Browser",
    description: "Close the browser and static server. State resets on next launch.",
    promptSnippet: "Close the browser",
    parameters: Type.Object({}),
    run: () => session.close().then(() => text("closed")),
  },
  {
    name: "cext_reload",
    label: "Reload Extension",
    description:
      "Reload the extension by relaunching the browser with the same options.",
    promptSnippet: "Reload the extension",
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
      "Run N browser steps in one call — the action surface (click/fill/press/.../eval). One call = one round trip.",
    promptSnippet: "Run many browser steps in one call",
    promptGuidelines: [
      "cext_batch is the action surface: click/fill/press/select/hover/wait/scroll/history/open/switch/closePage/eval/screenshot/logs/metrics are steps in it, not tools of their own.",
      "Brain-efficient cheapest pattern: {op:'fillForm', fields:{'#a':'v'}} + {op:'extract', selectors:{email:'#e'}, aria:true} + {op:'assert', checks:[{selector:'#x',value:'y'},{url:'endsWith:?'}]} in ONE batch — 1 call vs 3, 6× fewer tokens than raw innerText/eval loops.",
      "Use extract over eval+innerHTML.slice and fillForm over N fills; both return compact JSON with truncated/hash/cached so unchanged DOM costs 0 tokens. extract auto:true auto-waits hydration + scrolls for lazy content + discovers interactive disclosures/toggles — use it first for any site.",
      "Pass snapshot:true only when you need raw bodyText; prefer extract (pruned aria+selectors) — snapshot marks truncated/cached.",
      "Steps run in order; stopOnError:true stops at first failure and reports stoppedAt; each step returns ms/chars and batch returns telemetry {totalMs,totalChars}.",
    ],
    parameters: Type.Object({
      steps: Type.Array(batchStep, { description: "Steps to run, in order" }),
      snapshot: Type.Optional(
        Type.Boolean({ description: "Include body text (default false)" })
      ),
      stopOnError: Type.Optional(
        Type.Boolean({ description: "Stop at first failure (default true)" })
      ),
      record: Type.Optional(Type.Boolean({ description: "Save steps to scenarios/auto-<ts>.json for zero-cost replay (no new tool)" })),
    }),
    run: async (p, ctx) => {
      const r: any = await session.batch(p.steps, { snapshot: p.snapshot ?? false, stopOnError: p.stopOnError ?? true });
      if (p.record) {
        try {
          const { mkdirSync, writeFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          const dir = join(ctx.cwd || process.cwd(), "browser-tester", "scenarios");
          mkdirSync(dir, { recursive: true });
          const out = join(dir, `auto-${Date.now()}.json`);
          writeFileSync(out, JSON.stringify({ launch: session.launchOpts || {}, steps: p.steps, stopOnError: p.stopOnError ?? true }, null, 2));
          (r as any).recorded = out;
        } catch {}
      }
      return text(
        `${r.results.map(stepLine).join("\n")}\n--- final ---\n${r.final.url}\n${r.final.title ?? ""}` +
          (r.stoppedAt === null ? "" : `\nstopped at step ${r.stoppedAt}`) +
          (r.telemetry ? `\n[telemetry] ${r.telemetry.totalMs}ms ${r.telemetry.totalChars} chars over ${r.telemetry.steps} steps` : "") +
          (r.final.truncated ? ` [snapshot truncated ${r.final.origLen}→${(r.final.bodyText||"").length}]` : "") +
          (r.final.cached ? ` [cached ${r.final.hash}]` : "") +
          ((r as any).recorded ? `\n[recorded] ${(r as any).recorded}` : ""),
        { r }
      );
    },
  },
  {
    name: "cext_cdp",
    label: "Raw CDP",
    description:
      "Send a raw CDP command to the page or browser.",
    promptSnippet: "Send a raw CDP command",
    parameters: Type.Object({
      method: Type.String({ description: "CDP method, e.g. Network.enable" }),
      params: Type.Optional(Type.Any({ description: "CDP params object" })),
      target: Type.Optional(oneOf(["page", "browser"], "Target: page or browser")),
    }),
    run: (p) =>
      session.cdp(p.method, p.params ?? {}, { target: p.target ?? "page" }).then((r) =>
        text(`${p.method} → ${JSON.stringify(r) ?? "(no result)"}`, { r })
      ),
  },
];

export default function browserTester(pi: ExtensionAPI) {
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
          throw new Error(fail(e));
        }
      },
    });
  }

  pi.on("session_shutdown", async () => {
    await session.close().catch(() => {});
  });
}
