// Manual pre-install for Playwright's Chromium (Chrome for Testing).
// The extension auto-installs it on first cext_launch, so you rarely need this.

import { installChromium } from "../src/session.js";

installChromium().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
