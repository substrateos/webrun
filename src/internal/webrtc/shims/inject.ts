// esbuild inject file: shadows bare global references to Buffer, setImmediate,
// and clearImmediate with module-scoped imports from the shim.
//
// esbuild's `inject` mechanism prepends these imports to every module in the
// bundle, causing the local binding to shadow the global.

export { Buffer, setImmediate, clearImmediate, process } from "./globals.ts";
