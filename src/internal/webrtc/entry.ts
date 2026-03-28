// Entry point for the esbuild bundle.
// Uses bare "werift" (not "npm:werift") so esbuild's Node resolver can find
// it in node_modules. The "npm:" prefix is a Deno-specific specifier.
export * from "werift";
export { __initStrictUdpChannel } from "./shims/dgram.ts";
export { __initNodeGlobals } from "./shims/globals.ts";
export { __initNetworkInterfaces } from "./shims/os.ts";
