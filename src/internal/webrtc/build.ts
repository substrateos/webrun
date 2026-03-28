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
var require = __webrtc_createRequire(import.meta.url);
`;

const result = await esbuild.build({
    entryPoints: ["src/internal/webrtc/entry.ts"],
    outfile: "src/internal/webrtc/bundle.js",
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    alias: {
        "dgram": "./src/internal/webrtc/shims/dgram.ts",
        "node:dgram": "./src/internal/webrtc/shims/dgram.ts",
        "os": "./src/internal/webrtc/shims/os.ts",
        "node:os": "./src/internal/webrtc/shims/os.ts",
    },
    inject: ["src/internal/webrtc/shims/inject.ts"],
    plugins: [nodeRewritePlugin],
    nodePaths: ["src/internal/webrtc/node_modules"],
    logLevel: "error",
    banner: { js: requireBanner },
});
esbuild.stop();

if (result.errors.length === 0) {
    // Post-build: patch sandbox-incompatible defaults baked into werift.
    //
    // werift ships with hardcoded Google STUN server fallbacks. In the WebRun
    // sandbox, outbound UDP to external hosts is blocked by the OS seatbelt.
    // These patches replace the fallbacks with null so that:
    //   - Gathering only produces host candidates (no srflx via STUN)
    //   - ICE connectivity checks only use local sockets (no external STUN)
    //
    // When a caller explicitly passes { iceServers: [ { urls: "stun:..." } ] },
    // those ARE still honoured. Only the unconditional fallbacks are patched.
    const bundlePath = "src/internal/webrtc/bundle.js";
    let bundle = await Deno.readTextFile(bundlePath);

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

    await Deno.writeTextFile(bundlePath, bundle);

    // Reproducible builds: canonicalize webrtc_bundle.js to deno bundle's fixed point.
    //
    // deno bundle's sourcesContent stores an AST re-serialization of imported .js
    // files, not the literal file bytes. This re-serialization strips TS-directive
    // comments (like @ts-ignore) and changes expression line-wrapping. Critically,
    // this transformation is NOT idempotent: format(format(x)) ≠ format(x).
    //
    // However, the sequence DOES converge: each pass only removes information
    // (comments, whitespace), so it reaches a fixed point within a few iterations.
    // We loop until the file hash stabilizes.
    const smPrefix = "//# sourceMappingURL=data:application/json;base64,";
    const MAX_CANON_PASSES = 5;
    for (let pass = 0; pass < MAX_CANON_PASSES; pass++) {
        const prevContent = await Deno.readTextFile(bundlePath);
        const canonCmd = new Deno.Command(Deno.execPath(), {
            args: ["bundle", "--config", "deno.json", "--external=webrun/ctx",
                   "--sourcemap=inline", "webrun.ts"],
            stdout: "piped",
            stderr: "piped",
        });
        const canonOut = await canonCmd.output();
        if (!canonOut.success) {
            console.warn("Warning: canonicalization pass", pass, "failed:",
                new TextDecoder().decode(canonOut.stderr).slice(0, 200));
            break;
        }
        const canonText = new TextDecoder().decode(canonOut.stdout);
        const smIdx = canonText.lastIndexOf(smPrefix);
        if (smIdx < 0) {
            console.warn("Warning: no inline sourcemap found in canonicalization pass", pass);
            break;
        }
        const b64 = canonText.substring(smIdx + smPrefix.length).trim();
        let canonical: string;
        try {
            const sm = JSON.parse(atob(b64));
            const srcIdx = sm.sources.findIndex((s: string) => s.includes("webrtc/bundle.js"));
            if (srcIdx < 0 || !sm.sourcesContent[srcIdx]) {
                console.warn("Warning: webrtc_bundle.js not found in sourcemap (pass", pass + ")");
                break;
            }
            canonical = sm.sourcesContent[srcIdx];
        } catch (e) {
            console.warn("Warning: sourcemap parse failed (pass", pass + "):", e);
            break;
        }
        if (canonical === prevContent) {
            // Fixed point reached — sourcesContent matches the file on disk.
            break;
        }
        await Deno.writeTextFile(bundlePath, canonical);
    }

    console.log(`WebRTC bundle complete. 0 errors, 0 warnings (${patchCount}/${patches.length} sandbox patches applied)`);
} else {
    console.error("WebRTC bundle failed:", result.errors.length, "errors");
}
