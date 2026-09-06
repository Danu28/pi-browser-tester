// Auto-discovery entry for drop-in installs: pi looks for <extensions-dir>/index.ts,
// so this shim makes the whole repo folder (or install.bat's copy under
// ~/.pi/agent/extensions/browser-extension-tester/) show up as an extension.
// pi install (package.json "pi.extensions") and `pi -e ./extensions/index.ts`
// load the real entry directly and never see this file.
export { default } from "./extensions/index.ts";