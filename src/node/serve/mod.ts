/**
 * Node-compat serve adapter.
 *
 * Creates HTTP/HTTPS servers using node:http / node:https,
 * bridging Node's IncomingMessage/ServerResponse to the
 * standard Request/Response model of ServeHandler.
 *
 * Node modules are injected via the `node` parameter so this
 * module contains no platform imports — only type references.
 */

import type * as http from "node:http";
import type * as https from "node:https";
import type * as tls from "node:tls";
import type * as net from "node:net";

import type {
    ServeContext,
    ServeHandler,
    ServeOptions,
    ServeResult,
} from "../../core/serve/types.ts";

export type { ServeContext, ServeHandler, ServeOptions, ServeResult };

// ── Node-specific types ─────────────────────────────────────────────────────

/** The node modules to inject. */
export interface NodeModules {
    http: typeof http;
    https: typeof https;
    tls: typeof tls;
    net: typeof net;
}


// ── Request look-alike for CONNECT ──────────────────────────────────────────

/**
 * The Fetch spec forbids "CONNECT" as a Request method, so
 * new Request(url, { method: "CONNECT" }) throws. We create a
 * plain object with the same readable surface and cast it.
 */
function createConnectRequest(
    target: string,
    headers: Headers,
): Request {
    return {
        method: "CONNECT",
        url: `http://${target}`,
        headers,
        body: null,
        bodyUsed: false,
        cache: "default",
        credentials: "same-origin",
        destination: "",
        integrity: "",
        keepalive: false,
        mode: "cors",
        redirect: "follow",
        referrer: "about:client",
        referrerPolicy: "",
        signal: new AbortController().signal,
        clone() { return createConnectRequest(target, new Headers(headers)); },
        arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); },
        blob() { return Promise.resolve(new Blob()); },
        formData() { return Promise.reject(new TypeError("CONNECT has no body")); },
        json() { return Promise.reject(new TypeError("CONNECT has no body")); },
        text() { return Promise.resolve(""); },
        bytes() { return Promise.resolve(new Uint8Array()); },
    } as unknown as Request;
}


// ── Implementation ──────────────────────────────────────────────────────────

/**
 * Creates a serve function backed by node:http / node:https.
 *
 * Usage:
 *   const serve = makeServe({ node: { http, https, tls, net } });
 *   const { urls, shutdown } = await serve(handler, { listen: [...] });
 */
export function makeServe(deps: { node: NodeModules }): (
    handler: ServeHandler,
    options?: ServeOptions,
) => Promise<ServeResult> {
    const { http, https, tls, net } = deps.node;

    return async function serve(
        handler: ServeHandler,
        options: ServeOptions = {},
    ): Promise<ServeResult> {
        const useTls = !!options.tls;
        const scheme = useTls ? "https" : "http";

        // ── Request conversion ──────────────────────────────────────

        function toRequest(req: http.IncomingMessage): Request {
            // Proxy requests have absolute URLs; normal requests are relative.
            const raw = req.url || "/";
            const url = raw.startsWith("http")
                ? raw
                : `${scheme}://${req.headers.host || "localhost"}${raw}`;

            const headers = new Headers();
            for (const [key, value] of Object.entries(req.headers)) {
                if (value === undefined) continue;
                if (Array.isArray(value)) {
                    for (const v of value) headers.append(key, v);
                } else {
                    headers.set(key, value);
                }
            }

            // Pass body for methods that carry one.
            const hasBody = req.method !== "GET" && req.method !== "HEAD";
            return new Request(url, {
                method: req.method,
                headers,
                ...(hasBody ? { body: req as any, duplex: "half" } : {}),
            });
        }

        // ── Response conversion ─────────────────────────────────────

        async function writeResponse(
            nodeRes: http.ServerResponse,
            response: Response,
        ): Promise<void> {
            const headers: Record<string, string> = {};
            for (const [k, v] of response.headers.entries()) {
                headers[k] = v;
            }
            nodeRes.writeHead(response.status, headers);
            if (response.body) {
                const reader = response.body.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        nodeRes.write(value);
                    }
                } finally {
                    reader.releaseLock();
                }
            }
            nodeRes.end();
        }

        // ── Request handler ─────────────────────────────────────────

        const requestListener = (
            req: http.IncomingMessage,
            res: http.ServerResponse,
        ) => {
            const request = toRequest(req);
            const ctx: ServeContext = {
                upgradeWebSocket: () => {
                    throw new Error(
                        "upgradeWebSocket is not yet implemented for node serve",
                    );
                },
            };

            Promise.resolve(handler(request, ctx))
                .then((response) => writeResponse(res, response))
                .catch(() => {
                    try {
                        res.writeHead(500);
                        res.end();
                    } catch { /* already sent */ }
                });
        };

        // ── Server creation ─────────────────────────────────────────

        let server: http.Server;

        if (useTls) {
            const tlsOpts = options.tls!;
            const serverOpts: https.ServerOptions = {
                cert: tlsOpts.cert,
                key: tlsOpts.key,
            };
            if (tlsOpts.SNICallback) {
                const sniCallback = tlsOpts.SNICallback;
                serverOpts.SNICallback = (
                    hostname: string,
                    cb: (err: Error | null, ctx?: tls.SecureContext) => void,
                ) => {
                    sniCallback(hostname).then(
                        ({ cert, key }) => {
                            const ctx = tls.createSecureContext({ cert, key });
                            cb(null, ctx);
                        },
                        (err) => cb(err),
                    );
                };
            }
            server = https.createServer(serverOpts, requestListener);
        } else {
            server = http.createServer(requestListener);
        }

        // ── CONNECT handler ─────────────────────────────────────────
        // CONNECT arrives via the "connect" event on the raw TCP layer.
        // The Fetch spec forbids CONNECT in the Request constructor, so
        // we create a Request look-alike and route it through the same
        // handler with upgradeConnect available on the context.

        server.on(
            "connect",
            (
                req: http.IncomingMessage,
                clientSocket: net.Socket,
                head: Buffer,
            ) => {
                const target = req.url || "";
                const headers = new Headers();
                for (const [key, value] of Object.entries(req.headers)) {
                    if (value === undefined) continue;
                    if (Array.isArray(value)) {
                        for (const v of value) headers.append(key, v);
                    } else {
                        headers.set(key, value);
                    }
                }

                const request = createConnectRequest(target, headers);
                const ctx: ServeContext = {
                    upgradeWebSocket: () => {
                        throw new Error(
                            "Cannot upgradeWebSocket on a CONNECT request",
                        );
                    },
                    upgradeConnect: () => ({
                        readable: new ReadableStream({
                            start(controller) {
                                if (head && head.length > 0) controller.enqueue(new Uint8Array(head));
                                clientSocket.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
                                clientSocket.on("end", () => controller.close());
                                clientSocket.on("error", (err) => controller.error(err));
                            },
                            cancel() {
                                clientSocket.destroy();
                            }
                        }),
                        writable: new WritableStream({
                            write(chunk) {
                                return new Promise((resolve, reject) => {
                                    clientSocket.write(chunk, (err) => {
                                        if (err) reject(err);
                                        else resolve();
                                    });
                                });
                            },
                            close() {
                                return new Promise<void>((resolve) => clientSocket.end(() => resolve()));
                            },
                            abort() {
                                clientSocket.destroy();
                            }
                        }),
                    }),
                };

                Promise.resolve(handler(request, ctx))
                    .then((response) => {
                        if (response.status >= 200 && response.status < 300) {
                            clientSocket.write(
                                `HTTP/1.1 ${response.status} ${response.statusText || "Connection Established"}\r\n\r\n`,
                            );
                        } else {
                            clientSocket.write(
                                `HTTP/1.1 ${response.status} ${response.statusText || "Error"}\r\n\r\n`,
                            );
                            clientSocket.end();
                        }
                    })
                    .catch(() => {
                        clientSocket.write(
                            "HTTP/1.1 502 Bad Gateway\r\n\r\n",
                        );
                        clientSocket.end();
                    });
            },
        );

        // ── Listen ──────────────────────────────────────────────────

        const listenUrl =
            options.listen?.length
                ? new URL(String(options.listen[0]))
                : new URL("http://127.0.0.1:0");

        const port = parseInt(listenUrl.port) || 0;
        server.listen(port, listenUrl.hostname);
        await new Promise<void>((r) => server.on("listening", r));
        const addr = server.address() as net.AddressInfo;

        // ── Signal handling ─────────────────────────────────────────

        if (options.signal) {
            options.signal.addEventListener(
                "abort",
                () => server.close(),
                { once: true },
            );
        }

        // ── Result ──────────────────────────────────────────────────

        const url = new URL(
            `${scheme}://${listenUrl.hostname}:${addr.port}/`,
        );
        return {
            urls: [url],
            shutdown: () =>
                new Promise<void>((r) => server.close(() => r())),
        };
    };
}
