/**
 * @webrun/deno/serve — HTTP server extension.
 *
 * Thin wrapper that captures Deno.serve before scrub and provides
 * ctx.serve() using the Deno serve adapter.
 *
 * When TLS with SNICallback is requested, falls through to the
 * Node serve adapter via node: compat (Deno.serve doesn't support
 * dynamic SNI-based cert selection).
 *
 * Node modules are eagerly imported BEFORE scrub runs, because
 * Deno's node compat layer needs Deno globals during initialization.
 *
 * Deno.build is captured before scrub and temporarily restored
 * around https.createServer — the only Deno property that node:tls
 * accesses during sync server construction.
 */
import type { Extension } from "../../../extensions/mod.ts";
import type { ServeHandler, ServeOptions } from "../../../core/serve/types.ts";
import createDenoServe from "../../serve/mod.ts";
import { makeServe as makeNodeServe } from "../../../node/serve/mod.ts";

const serveExt: Extension = async (ctx, next) => {
    const Deno = (globalThis as any).Deno;

    if (typeof Deno?.serve !== "function") {
        await next(ctx);
        return;
    }

    const denoServe = createDenoServe({
        serve: Deno.serve.bind(Deno),
        upgradeWebSocket: Deno.upgradeWebSocket.bind(Deno),
    });

    // Eagerly import node modules while Deno globals are still alive,
    // but only when tcp is permitted (needed for TLS serve with SNICallback).
    let nodeServe: ReturnType<typeof makeNodeServe> | null = null;
    if (ctx.permissions?.tcp) {
        const [http, https, tls, net] = await Promise.all([
            import("node:http"),
            import("node:https"),
            import("node:tls"),
            import("node:net"),
        ]);

        // Capture the only Deno property that node:tls accesses during
        // sync server construction (verified by proxy tracing).
        const denoBuild = Deno.build;

        const rawServe = makeNodeServe({ node: { http, https, tls, net } });

        // Wrap to temporarily restore a minimal Deno stub around the
        // sync https.createServer call. Scrub deletes globalThis.Deno
        // but node:tls getters re-read Deno.build on every access.
        nodeServe = async (handler, options) => {
            (globalThis as any).Deno = { build: denoBuild };
            try {
                return await rawServe(handler, options);
            } finally {
                delete (globalThis as any).Deno;
            }
        };
    }

    ctx.serve = (handler: ServeHandler, options?: ServeOptions) => {
        if (options?.tls?.SNICallback) {
            if (!nodeServe) {
                throw new Error("TLS serve with SNICallback requires permissions.tcp");
            }
            return nodeServe(handler, options);
        }
        return denoServe(handler, options);
    };

    await next(ctx);
};

export default serveExt;
