// Replay a recorded scenario end to end with no model in the loop.
//   node scripts/scenario.mjs scenarios/dummy-form.json
//
// The step vocabulary is exactly cext_batch's, because session.batch already IS
// the interpreter: this file is glue (read -> launch -> batch -> print -> exit).
// A scenario asserts by throwing — the last step is normally an eval IIFE that
// reads the page and throws when it is wrong, so a failed assertion is just a
// failed step and needs no extra machinery.
//
// ponytail: still pi-free and still browser-required, like session.js — the
// whole point is that this runs from a plain shell with zero model round trips.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { ChromeExtSession, stepLine } from "../src/session.js";

const firstLine = (s) => String(s).split("\n")[0];
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith("--"));
const wantReport = args.includes("--report") || args.some(a => a.startsWith("--report"));
const reportHtml = wantReport;
if (!file) {
  console.error("usage: node scripts/scenario.mjs <scenario.json> [--report]");
  process.exit(2);
}

let scenario;
try {
  scenario = JSON.parse(readFileSync(resolve(file), "utf8"));
} catch (e) {
  console.error(`${file}: ${e.message}`);
  process.exit(2);
}
const { launch = {}, steps, stopOnError = true } = scenario;
if (!Array.isArray(steps) || steps.length === 0) {
  console.error(`${file}: scenario needs a non-empty "steps" array`);
  process.exit(2);
}

const session = new ChromeExtSession();
let crash = null;
let failed = null;
let url = null;
let run = null;
try {
  await session.launch({ cwd: process.cwd(), ...launch });
  run = await session.batch(steps, { stopOnError });
  url = run.final.url;
  for (const r of run.results) console.log(stepLine(r.error ? { ...r, error: firstLine(r.error) } : r));
  if (run.telemetry) console.log(`[telemetry] ${run.telemetry.totalMs}ms ${run.telemetry.totalChars} chars`);
  failed = run.results.find((r) => r.error) ?? null;
} catch (e) {
  crash = e;
} finally {
  await session.close().catch(() => {});
}

if (reportHtml && run) {
  try {
    const dir = join(process.cwd(), "artifacts");
    mkdirSync(dir, { recursive: true });
    const html = `<!doctype html><meta charset="utf-8"><title>scenario ${file}</title><style>body{font:13px system-ui;padding:16px} .ok{color:green}.fail{color:red} pre{background:#f6f8fa;padding:10px;border-radius:8px}</style><h1>${file} — ${failed||crash?"FAIL":"PASS"}</h1><p>${steps.length} steps → ${url||""}</p><pre>${run.results.map(stepLine).join("\n")}</pre><p>telemetry: ${run.telemetry?`${run.telemetry.totalMs}ms ${run.telemetry.totalChars} chars`:""}</p>`;
    const out = join(dir, `scenario-${Date.now()}.html`);
    writeFileSync(out, html);
    console.log(`report: ${out}`);
  } catch {}
}

if (crash) {
  console.error(`\nFAILED: ${firstLine(crash.message)}`);
  process.exit(1);
}
if (failed) {
  console.error(`\nFAILED at step ${failed.i} (${failed.op}): ${firstLine(failed.error)}`);
  process.exit(1);
}
console.log(`\nok: ${steps.length} steps → ${url}`);
