/**
 * Deno serve adapter.
 *
 * Implements the webrun serve contract using Deno.serve().
 * The Deno runtime is injected as a typed interface — no
 * global Deno reference.
 *
 * Ephemeral binds (port 0) are automatically protected with
 * basic auth credentials embedded in the returned capability URLs.
 */

import type {
    ServeContext,
    ServeHandler,
    ServeOptions,
    ServeResult,
    ServeFn,
} from "../../core/serve/types.ts";

// ── Injected Deno surface ───────────────────────────────────────────────────

/** Precisely the Deno APIs we need. */
export interface DenoServeRuntime {
    serve(
        options: {
            port: number;
            hostname: string;
            signal: AbortSignal;
            onListen: () => void;
        },
        handler: (req: Request) => Response | Promise<Response>,
    ): { addr: { port: number } };

    upgradeWebSocket(
        req: Request,
        opts?: { protocol?: string; idleTimeout?: number },
    ): { socket: WebSocket; response: Response };
}

// ── Basic auth utilities ────────────────────────────────────────────────────

const encoder = new TextEncoder();

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a[i] ^ b[i];
    }
    return diff === 0;
}

function withBasicAuth(
    name: string,
    token: string,
    handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Response | Promise<Response> {
    const expectedToken = encoder.encode(token);
    const authenticate = `Basic realm="${name}"`;

    return (req) => {
        const auth = req.headers.get("Authorization");
        if (!auth?.startsWith("Basic ")) {
            return new Response(null, { status: 401, headers: { "WWW-Authenticate": authenticate } });
        }

        let decoded: string;
        try { decoded = atob(auth.slice(6)); } catch {
            return new Response(null, { status: 401, headers: { "WWW-Authenticate": authenticate } });
        }

        const colonIdx = decoded.indexOf(":");
        if (colonIdx === -1) {
            return new Response(null, { status: 401, headers: { "WWW-Authenticate": authenticate } });
        }

        const reqName = decoded.slice(0, colonIdx);
        const reqToken = decoded.slice(colonIdx + 1);

        if (reqName !== name || !timingSafeEqual(encoder.encode(reqToken), expectedToken)) {
            return new Response("Forbidden", { status: 403 });
        }

        const stripped = new Request(req, { headers: new Headers(req.headers) });
        stripped.headers.delete("Authorization");
        return handler(stripped);
    };
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates a serve function backed by Deno.serve().
 *
 * Usage:
 *   const serve = createDenoServe({ serve: Deno.serve.bind(Deno), upgradeWebSocket: Deno.upgradeWebSocket.bind(Deno) });
 *   const { urls, shutdown } = await serve(handler, { listen: [...] });
 */
export default function createDenoServe(rt: DenoServeRuntime): ServeFn {
    return async function serve(
        handler: ServeHandler,
        options: ServeOptions = {},
    ): Promise<ServeResult> {
        const ac = new AbortController();
        if (options.signal) {
            if (options.signal.aborted) ac.abort(options.signal.reason);
            else options.signal.addEventListener(
                "abort",
                () => ac.abort(options.signal!.reason),
                { once: true },
            );
        }

        const listen = options.listen?.length
            ? options.listen.map((u) => new URL(String(u)))
            : [new URL("http://127.0.0.1:0")];

        const wrappedHandler = (req: Request) => handler(req, {
            upgradeWebSocket: (opts) => rt.upgradeWebSocket(req, opts),
        });

        const urls: URL[] = [];
        for (const u of listen) {
            const ephemeral = !(parseInt(u.port) > 0);
            const authName = u.username || (ephemeral ? crypto.randomUUID() : null);
            const authToken = u.password || (ephemeral ? crypto.randomUUID() : null);

            const thisHandler = (authName && authToken)
                ? withBasicAuth(authName, authToken, wrappedHandler)
                : wrappedHandler;

            const server = rt.serve(
                {
                    port: parseInt(u.port) || 0,
                    hostname: u.hostname,
                    signal: ac.signal,
                    onListen: () => {},
                },
                thisHandler,
            );
            const url = new URL(`http://${u.hostname}:${server.addr.port}/`);
            if (authName && authToken) {
                url.username = authName;
                url.password = authToken;
            }
            urls.push(url);
        }

        return {
            urls,
            shutdown: async () => ac.abort(),
        };
    };
}
