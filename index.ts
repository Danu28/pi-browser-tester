// Canonical entry for pi (package.json "pi.extensions" points here, and drop-in
// installs use this same index.ts). It re-exports the real implementation in
// extensions/index.ts; pointing the manifest at the directory instead would make
// pi name the extension after the folder ("extensions"), not the package.
export { default } from "./extensions/index.ts";