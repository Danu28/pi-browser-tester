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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ChromeExtSession } from "../src/session.js";

const firstLine = (s) => String(s).split("\n")[0];
const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/scenario.mjs <scenario.json>");
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
try {
  await session.launch({ cwd: process.cwd(), ...launch });
  const run = await session.batch(steps, { stopOnError });
  url = run.final.url;
  for (const r of run.results) {
    const what = `${r.i} ${r.op}${r.selector ? ` ${r.selector}` : ""}`;
    console.log(r.error ? `${what} — FAIL: ${firstLine(r.error)}` : r.op === "eval" ? `${what} → ${r.result}` : `${what} — ok`);
  }
  failed = run.results.find((r) => r.error) ?? null;
} catch (e) {
  crash = e;
} finally {
  // A failed scenario must not leave Chromium (and its profile dir) behind for
  // the next run to trip over.
  await session.close().catch(() => {});
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
