// Cross-platform helper for installing Playwright's Chromium (Chrome for Testing).
// Raises the download timeout: the default 30s is too short on slow links, which
// fails installs for many users. Run via: npm run install-browser
//
// Note: this is only the manual/pre-install path — the extension also auto-installs
// the browser on first cext_launch, so you normally don't need to run it at all.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";

console.log("Installing Chromium (Chrome for Testing) with a 600s download timeout...");
const child = spawn(
  isWin ? "cmd.exe" : "/bin/sh",
  isWin ? ["/d", "/s", "/c", "npx playwright install chromium"] : ["-c", "npx playwright install chromium"],
  {
    cwd: PKG_ROOT, // resolve the local playwright CLI even when none is global
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: "600000" },
  }
);
child.on("exit", (code) => process.exit(code ?? 1));

// Still failing? Try a mirror of the browser archive:
//   PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npm run install-browser
// or download the CfT zip manually from https://googlechromelabs.github.io/chrome-for-testing/
// and extract it to %LOCALAPPDATA%/ms-playwright/chromium-<revision>/ (Windows) or
// ~/.cache/ms-playwright/chromium-<revision>/ (macOS/Linux) plus an
// INSTALLATION_COMPLETE marker file (see the project README for details).