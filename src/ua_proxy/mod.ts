/**
 * UA Proxy — MITM HTTPS proxy for browser-like User-Agent
 *
 * Starts a local forward proxy that intercepts HTTP and HTTPS
 * traffic, rewriting the User-Agent to a browser string so
 * CDNs serve browser-targeted ES module builds.
 *
 * Platform-agnostic: all platform capabilities are injected.
 * - serve: webrun serve contract (handles HTTP, TLS, CONNECT)
 * - TCPSocket: Direct Sockets API for CONNECT tunnel piping
 *
 * Architecture:
 *   1. TLS server (HTTPS, SNICallback) — decrypts CONNECT tunnels
 *   2. Front-door server (HTTP) — accepts CONNECT + plain proxying
 *   Both call the same fetch handler (fetch.ts).
 */

import type { TCPSocketConstructor, TCPSocketOpenInfo } from "../core/direct_sockets/types.ts";
import { generateCA, generateHostCert } from "./tls.ts";
import proxy from "./fetch.ts";

// ── Injected serve contract ─────────────────────────────────────────────────

/** Context available to the handler for each request. */
export interface ServeContext {
    /** Upgrade a CONNECT request to a bidirectional byte stream.
     *  Only available when req.method === "CONNECT". */
    upgradeConnect?: () => ConnectInfo;
}

/** Bidirectional byte streams for a CONNECT tunnel. */
export interface ConnectInfo {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
}

/** TLS configuration for the serve layer. */
export interface TlsConfig {
    cert: string;
    key: string;
    SNICallback: (hostname: string) => Promise<{ cert: string; key: string }>;
}

/** Result of starting a server. */
export interface ServeResult {
    urls: URL[];
    shutdown: () => Promise<void>;
}

/** Handler function: receives a Request, returns a Response. */
export type ServeHandler = (
    req: Request,
    ctx: ServeContext,
) => Response | Promise<Response>;

/** The serve function contract this module requires. */
export type ServeFn = (
    handler: ServeHandler,
    options: {
        listen?: string[];
        tls?: TlsConfig;
    },
) => Promise<ServeResult>;

// ── Dependencies ────────────────────────────────────────────────────────────

export interface UAProxyDeps {
    serve: ServeFn;
    TCPSocket: TCPSocketConstructor;
}

// ── Result ──────────────────────────────────────────────────────────────────

export interface UAProxy {
    /** Local port the proxy listens on. */
    port: number;
    /** PEM-encoded CA certificate for the ephemeral CA. */
    caCertPem: string;
    /** Shut down the proxy and all servers. */
    shutdown: () => Promise<void>;
}

// ── Cert cache ──────────────────────────────────────────────────────────────

function createCertCache(
    caPrivateKey: CryptoKey,
    caCertPem: string,
): (hostname: string) => Promise<{ cert: string; key: string }> {
    const cache = new Map<string, { cert: string; key: string }>();
    const pending = new Map<string, Promise<{ cert: string; key: string }>>();

    return async function getCert(hostname: string) {
        const cached = cache.get(hostname);
        if (cached) return cached;

        let promise = pending.get(hostname);
        if (!promise) {
            promise = (async () => {
                const hostCert = await generateHostCert(
                    hostname,
                    caPrivateKey,
                    caCertPem,
                );
                const entry = { cert: hostCert.certPem, key: hostCert.keyPem };
                cache.set(hostname, entry);
                pending.delete(hostname);
                return entry;
            })();
            pending.set(hostname, promise);
        }
        return promise;
    };
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Starts the UA proxy.
 *
 * @param deps - Injected platform capabilities (serve + TCPSocket).
 * @returns The proxy port, CA cert PEM, and shutdown function.
 */
export async function startUAProxy(deps: UAProxyDeps): Promise<UAProxy> {
    const { serve, TCPSocket } = deps;
    const ca = await generateCA();
    const getCert = createCertCache(ca.privateKey, ca.certPem);

    // ── 1. TLS termination server ───────────────────────────────────

    const tlsServer = await serve(proxy.fetch, {
        listen: ["https://127.0.0.1:0"],
        tls: {
            cert: ca.certPem,
            key: ca.keyPem,
            SNICallback: getCert,
        },
    });
    const tlsPort = Number(tlsServer.urls[0].port);

    // ── 2. Front-door proxy server ──────────────────────────────────

    const frontServer = await serve(
        async (req: Request, ctx: ServeContext): Promise<Response> => {
            if (req.method === "CONNECT") {
                if (!ctx.upgradeConnect) {
                    return new Response(null, { status: 501 });
                }
                const client = ctx.upgradeConnect();

                // Pipe CONNECT tunnel to the TLS server via TCPSocket.
                let local: TCPSocketOpenInfo;
                try {
                    const sock = new TCPSocket("127.0.0.1", tlsPort);
                    local = await sock.opened;
                } catch {
                    return new Response(null, {
                        status: 502,
                        statusText: "Bad Gateway",
                    });
                }

                // Bidirectional pipe — fire and forget.
                client.readable.pipeTo(local.writable).catch(() => {});
                local.readable.pipeTo(client.writable).catch(() => {});

                return new Response(null, {
                    status: 200,
                    statusText: "Connection Established",
                });
            }

            // Plain HTTP forward proxy.
            return proxy.fetch(req);
        },
        { listen: ["http://127.0.0.1:0"] },
    );

    return {
        port: Number(frontServer.urls[0].port),
        caCertPem: ca.certPem,
        shutdown: async () => {
            await tlsServer.shutdown();
            await frontServer.shutdown();
        },
    };
}
