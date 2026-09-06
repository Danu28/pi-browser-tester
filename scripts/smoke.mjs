// Zero-dependency smoke check for the browser-extension-tester core.
// src/session.js is playwright-only, so this proves the pure logic without pi
// or a browser. Run via: npm run check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeExtSession } from "../src/session.js";

const s = new ChromeExtSession();

// 1. hex -> extension-alphabet mapping ('0'-'9' -> 'a'-'j', 'a'-'f' -> 'k'-'p')
assert.equal(s._hexToId("0".repeat(32)), "a".repeat(32));
assert.equal(s._hexToId("f".repeat(32)), "p".repeat(32));
assert.equal(
  s._hexToId("0123456789abcdef0123456789abcdef"),
  "abcdefghijklmnopabcdefghijklmnop"
);

// 2. manifest "key" (base64) ID: SHA-256 of the raw key bytes — deterministic
assert.equal(
  s._extIdFromKey("dGVzdC1leHRlbnNpb24ta2V5LW1hdGVyaWFs"), // "test-extension-key-material"
  "nlopoonmdoikmjmmhpbhiidgnmedpafl"
);

// 3. path-derived IDs per platform encoding; on Windows a lowercased drive
//    letter must yield the same ID (Chromium's MaybeNormalizePath uppercases it)
if (process.platform === "win32") {
  assert.equal(
    s._extIdFromPath("C:\\Users\\Test\\sample-extension"),
    "lmlggfaiofnncalldopnckkkpjlffohh"
  );
  assert.equal(
    s._extIdFromPath("c:\\Users\\Test\\sample-extension"),
    "lmlggfaiofnncalldopnckkkpjlffohh"
  );
} else {
  assert.equal(
    s._extIdFromPath("/home/user/sample-extension"),
    "mimniejapmpcmpkjdhplnkoghfkgnldd"
  );
}

// 4. serve(): valid file, traversal guard, and a malformed % URL must not crash
const dir = mkdtempSync(join(tmpdir(), "cext-smoke-"));
try {
  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
  const { origin } = await s.serve(dir);
  const port = new URL(origin).port;
  const rawGet = (pathname) =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: pathname, headers: { connection: "close" } },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on("error", reject);
      req.end();
    });

  const ok = await rawGet("/");
  assert.equal(ok.status, 200);
  assert.equal(ok.body, "<h1>hi</h1>");
  // URL parsing collapses raw and %2e-encoded dot segments before the handler
  // sees them, so escape attempts stay inside the served root: %2e%2e must 404
  // (no such file in-root) and never return outside content.
  assert.equal((await rawGet("/%2e%2e/etc/passwd")).status, 404);
  assert.equal((await rawGet("/%")).status, 400); // previously crashed the process
} finally {
  await s.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log("smoke ok: id derivation + serve() guard");