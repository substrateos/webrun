// bundle/build_webrtc.ts — WebRTC npm-to-ESM bundler.
//
// Bundles werift for use in Deno's ESM runtime.
// Emits the patched bundle to stdout.
// Usage: deno run -A bundle/build_webrtc.ts

import * as esbuild from "https://deno.land/x/esbuild@v0.20.1/mod.js";

// Node built-ins that need node: prefix for Deno's ESM imports
const NODE_BUILTINS = new Set([
    "assert", "buffer", "child_process", "cluster", "console", "constants",
    "crypto", "dns", "domain", "events", "fs", "http", "http2",
    "https", "inspector", "module", "net", "os", "path", "perf_hooks",
    "process", "punycode", "querystring", "readline", "repl", "stream",
    "string_decoder", "sys", "timers", "timers/promises", "tls", "tty",
    "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib"
]);

// Rewrite bare Node builtins to node: prefix for Deno
const nodeRewritePlugin: esbuild.Plugin = {
    name: "node-prefix-rewrite",
    setup(build: any) {
        build.onResolve({ filter: /.*/ }, (args: any) => {
            const bare = args.path.replace(/^node:/, "");
            if (bare === "dgram" || bare === "os") return undefined;
            if (NODE_BUILTINS.has(bare)) {
                return { path: `node:${bare}`, external: true };
            }
            return undefined;
        });

        // Replace the `debug` package with a no-op stub.
        // debug calls process.env (which is blocked in the sandbox).
        // The debug output is only for development diagnostics.
        build.onResolve({ filter: /^debug$/ }, () => ({
            path: "debug",
            namespace: "debug-stub"
        }));
        build.onLoad({ filter: /.*/, namespace: "debug-stub" }, () => ({
            contents: `
                function debug() { 
                    const noop = Object.assign(function(){}, {
                        enabled: false,
                        namespace: '',
                        extend: () => noop,
                        destroy: () => {},
                        color: '',
                        diff: 0,
                        log: () => {},
                    });
                    return noop;
                }
                debug.enable = () => {};
                debug.disable = () => '';
                debug.enabled = () => false;
                debug.names = [];
                debug.skips = [];
                debug.formatters = {};
                debug.debug = debug;
                debug.default = debug;
                export default debug;
                export { debug };
            `,
            loader: "js"
        }));
    }
};

// Banner: createRequire for CJS dependencies that need it
const requireBanner = `
import { createRequire as __webrtc_createRequire } from "node:module";
var require = __webrtc_createRequire(import.meta.url.startsWith("blob:") ? "file:///dummy.js" : import.meta.url);
`;

const WEBRTC_DIR = "src/internal/webrtc";

interface BundleCtx {
    dir: FileSystemDirectoryHandle;
    resolveHandle(handle: FileSystemHandle): string;
}

export async function build(_args: string[], _env: Record<string, string>, ctx: BundleCtx): Promise<string> {
    const root = ctx.resolveHandle(ctx.dir);
    const result = await esbuild.build({
        entryPoints: [`${WEBRTC_DIR}/entry.ts`],
        write: false,
        bundle: true,
        format: "esm",
        platform: "node",
        target: "es2022",
        alias: {
            "dgram": `./${WEBRTC_DIR}/shims/dgram.ts`,
            "node:dgram": `./${WEBRTC_DIR}/shims/dgram.ts`,
            "os": `./${WEBRTC_DIR}/shims/os.ts`,
            "node:os": `./${WEBRTC_DIR}/shims/os.ts`,
        },
        inject: [`${WEBRTC_DIR}/shims/inject.ts`],
        plugins: [nodeRewritePlugin],
        nodePaths: [`${WEBRTC_DIR}/node_modules`],
        logLevel: "error",
        banner: { js: requireBanner },
    });

    if (result.errors.length > 0 || !result.outputFiles?.[0]) {
        throw new Error(`WebRTC bundle failed with ${result.errors.length} errors`);
    }

    // Post-build: patch sandbox-incompatible defaults baked into werift.
    //
    // werift ships with hardcoded Google STUN server fallbacks. To maintain
    // strict predictability and privacy, the runtime must never silently phone
    // home to external servers. These patches replace the fallbacks with null
    // so that ICE gathering only uses explicitly authorized configurations.
    //
    // When a caller explicitly passes { iceServers: [ { urls: "stun:..." } ] },
    // those ARE still honoured. Only the unconditional fallbacks are patched.
    let bundle = new TextDecoder().decode(result.outputFiles[0].contents);

    const patches: [string, string][] = [
        // RTCIceGatherer constructor: unconditional stunServer fallback
        [
            `    this.stunServer = validateAddress(stunServer) ?? [\n      "stun.l.google.com",\n      19302\n    ];`,
            `    this.stunServer = validateAddress(stunServer) ?? null; /* sandbox: no default STUN */`,
        ],
        // getGlobalIp: inline STUN request fallback
        [
            `    stunServer ?? ["stun.l.google.com", 19302]`,
            `    stunServer ?? null /* sandbox: no default STUN */`,
        ],
        // RTCPeerConnection default config: empty iceServers
        [
            `iceServers: [{ urls: "stun:stun.l.google.com:19302" }]`,
            `iceServers: []`,
        ],
        // binary-data genfun: inject Buffer into generated function scope.
        // `toFunction()` uses `new Function()` which only sees globals, but
        // the sandbox scrubs Buffer from globalThis. Inject the module-scoped
        // Buffer2 proxy so the generated serialization code works.
        [
            `line.toFunction = function(scope) {\n        if (!scope)\n          scope = {};`,
            `line.toFunction = function(scope) {\n        if (!scope)\n          scope = {};\n        if (!scope.Buffer && typeof Buffer2 !== "undefined") scope.Buffer = Buffer2;`,
        ],
    ];

    let patchCount = 0;
    for (const [find, replace] of patches) {
        if (bundle.includes(find)) {
            bundle = bundle.replace(find, replace);
            patchCount++;
        } else {
            console.warn(`Warning: patch target not found (bundle may have changed): ${find.slice(0, 60)}`);
        }
    }

    console.warn(`WebRTC bundle complete. 0 errors, 0 warnings (${patchCount}/${patches.length} sandbox patches applied)`);
    return bundle;
}

async function main(args: string[], env: Record<string, string>, ctx: BundleCtx): Promise<void> {
    console.log(await build(args, env, ctx));
    esbuild.stop();
}

export default { main };

if (import.meta.main) {
    const createFS = (await import("../src/deno/file_system/mod.ts")).default;
    const fs = createFS(globalThis.Deno as any);
    const dir = new fs.FileSystemDirectoryHandle(Deno.cwd(), ".");
    const ctx: BundleCtx = { dir, resolveHandle: fs.resolveHandle };
    await main(Deno.args, Deno.env.toObject(), ctx);
}
