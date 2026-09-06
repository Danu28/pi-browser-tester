// Install shim: this directory is only pi's discoverable entry point.
// The implementation lives once, at the repo root — do not copy sources in here
// (two copies used to drift apart silently and pi ran the stale one).
export { default } from "../../../extensions/index.ts";
