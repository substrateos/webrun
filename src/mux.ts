// =========================================================
// MUX: Streaming reverse proxy with constant-time token auth
// =========================================================
//
// Self-contained HTTP proxy that routes guest fetch requests to
// host-side binding processes. Each binding gets a unique bearer
// token; the proxy validates tokens using constant-time comparison
// to prevent timing side-channels. Request and response bodies
// stream end-to-end without buffering.

/** A binding registered with the mux proxy. */
export interface MuxBinding {
    name: string;
    port: number;
    token: string;
}

/** Handle to a running mux proxy instance. */
export interface MuxProxy {
    port: number;
    shutdown: () => Promise<void>;
}

/** Minimal system interface — listen + serve capabilities. */
export interface MuxRuntime {
    listen: typeof Deno.listen;
    serve: typeof Deno.serve;
}

const encoder = new TextEncoder();

/**
 * Constant-time comparison of two byte arrays.
 * Prevents timing side-channels on token validation.
 * All bytes are compared regardless of mismatch position.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false; // length is not secret (UUIDs are fixed 36 chars)
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a[i] ^ b[i];
    }
    return diff === 0;
}

/** Maximum retry attempts for ephemeral port binding. */
const BIND_RETRIES = 3;

/**
 * Starts a streaming reverse proxy on an ephemeral localhost port.
 *
 * Routes requests by validating the Authorization Bearer token against
 * a known set of bindings using constant-time comparison. Request and
 * response bodies stream through without buffering.
 *
 * Port binding note: An ephemeral port is discovered via listen({ port: 0 }),
 * then released so Deno.serve can bind it. A retry loop mitigates the narrow
 * TOCTOU window where another process could claim the port between close()
 * and serve(). Deno.serve({ listener }) was evaluated but does not handle
 * requests in Deno 2.7 — the listener is silently ignored.
 *
 * Returns null if bindings is empty (no proxy needed).
 */
export function startMuxProxy(
    sys: MuxRuntime,
    bindings: MuxBinding[],
): MuxProxy | null {
    if (bindings.length === 0) return null;

    // Pre-encode tokens as bytes for constant-time comparison
    const entries = bindings.map(b => ({
        tokenBytes: encoder.encode(b.token),
        port: b.port,
    }));

    function resolveToken(raw: string): number | null {
        const input = encoder.encode(raw);
        for (const entry of entries) {
            if (timingSafeEqual(input, entry.tokenBytes)) {
                return entry.port;
            }
        }
        return null;
    }

    const handler = async (req: Request) => {
        const auth = req.headers.get("Authorization");
        if (!auth?.startsWith("Bearer ")) {
            return new Response("Unauthorized", { status: 401 });
        }

        const targetPort = resolveToken(auth.slice(7));
        if (targetPort === null) {
            return new Response("Forbidden", { status: 403 });
        }

        const url = new URL(req.url);
        const upstream = `http://127.0.0.1:${targetPort}${url.pathname}${url.search}`;

        // Strip the Authorization header before forwarding
        const headers = new Headers(req.headers);
        headers.delete("Authorization");

        try {
            // Stream end-to-end: req.body pipes to upstream,
            // upstream Response.body pipes back to guest
            return await fetch(upstream, {
                method: req.method,
                headers,
                body: req.body,
            });
        } catch (e: any) {
            return new Response(e.message || "Upstream unavailable", { status: 502 });
        }
    };

    // Retry loop: discover ephemeral port, close, rebind via serve.
    // The TOCTOU window is microseconds; retries cover the rare collision.
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < BIND_RETRIES; attempt++) {
        const listener = sys.listen({ port: 0, hostname: "127.0.0.1" });
        const port = (listener.addr as Deno.NetAddr).port;
        listener.close();

        try {
            const server = sys.serve(
                { port, hostname: "127.0.0.1", onListen: () => {} },
                handler,
            );
            return {
                port,
                shutdown: () => server.shutdown(),
            };
        } catch (e: any) {
            lastError = e;
            // Port was stolen — retry with a new ephemeral port
        }
    }

    throw lastError || new Error("Failed to bind mux proxy after retries");
}
