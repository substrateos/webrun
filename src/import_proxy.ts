// =========================================================
// IMPORT PROXY: MITM HTTPS proxy for browser-like User-Agent
// =========================================================
//
// Deno's module loader hardcodes "Deno/<version>" as the User-Agent.
// Many CDNs (esm.sh, jsdelivr, etc.) serve different bundles based on
// the User-Agent, so we need to present a browser-like identity.
//
// Architecture:
//   1. A TCP server (node:net) accepts CONNECT tunnel requests.
//   2. For each CONNECT, a per-host Deno.listenTls is created lazily
//      with an ephemeral cert signed by the session CA.
//   3. After "200 Connection Established", bytes are relayed between
//      the client socket and the local TLS listener.
//   4. The TLS listener terminates the connection, reads the HTTP
//      request, rewrites the User-Agent, fetches the real target,
//      and streams the response back.
//   5. Plain HTTP requests are forwarded with browser UA directly.
//
// The sandbox gets:
//   --cert=<ca.pem>          Trust the ephemeral CA
//   HTTPS_PROXY=http://...   Route all HTTPS through this proxy
//   HTTP_PROXY=http://...    Route all HTTP through this proxy
//   NO_PROXY=127.0.0.1,...   Keep mux/binding traffic direct

import * as net from "node:net";
import { Buffer } from "node:buffer";
import { generateCA, generateHostCert } from "./tls_cert.ts";
import type { CABundle } from "./tls_cert.ts";

export const BROWSER_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Handle to a running MITM import proxy instance. */
export interface ImportProxy {
    /** Local port the proxy listens on. */
    port: number;
    /** PEM-encoded CA certificate for the ephemeral CA. */
    caCertPem: string;
    /** Shut down the proxy server and all per-host TLS listeners. */
    shutdown: () => Promise<void>;
}

// ── Relay: pipe bytes between Deno.Conn and a node:net Socket ───────────────

function relay(denoConn: Deno.Conn, nodeSocket: net.Socket): void {
    // Deno → Node
    (async () => {
        const buf = new Uint8Array(16384);
        try {
            while (true) {
                const n = await denoConn.read(buf);
                if (n === null) { nodeSocket.end(); break; }
                nodeSocket.write(buf.subarray(0, n));
            }
        } catch { nodeSocket.destroy(); }
    })();
    // Node → Deno
    nodeSocket.on("data", (chunk: Buffer) => {
        try { denoConn.write(chunk); } catch { nodeSocket.destroy(); }
    });
    nodeSocket.on("end", () => { try { denoConn.close(); } catch {} });
    nodeSocket.on("error", () => { try { denoConn.close(); } catch {} });
}

// ── Per-host TLS handler ────────────────────────────────────────────────────

async function handleTlsConn(conn: Deno.TlsConn, targetHost: string): Promise<void> {
    try {
        const buf = new Uint8Array(8192);
        const n = await conn.read(buf);
        if (n === null) { conn.close(); return; }

        const raw = new TextDecoder().decode(buf.subarray(0, n));
        const firstLine = raw.split("\r\n")[0];

        // Extract method and path from request line.
        const match = firstLine.match(/^(\w+) (\S+)/);
        const path = match ? match[2] : "/";

        // Fetch from real target with browser UA.
        const targetUrl = `https://${targetHost}${path}`;
        const resp = await fetch(targetUrl, {
            headers: { "User-Agent": BROWSER_USER_AGENT },
            redirect: "follow",
        });

        const body = await resp.arrayBuffer();
        const statusLine = `HTTP/1.1 ${resp.status} ${resp.statusText}\r\n`;
        const headers = [...resp.headers.entries()]
            .filter(([k]) => k !== "transfer-encoding")
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n");
        const responseStr = `${statusLine}${headers}\r\nContent-Length: ${body.byteLength}\r\n\r\n`;
        await conn.write(new TextEncoder().encode(responseStr));
        await conn.write(new Uint8Array(body));
        conn.close();
    } catch {
        try { conn.close(); } catch {}
    }
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Starts a local MITM HTTPS proxy that intercepts all traffic and rewrites
 * the User-Agent header to a browser-like string.
 *
 * HTTPS traffic is intercepted via CONNECT tunnels with per-host TLS
 * listeners using certificates signed by an ephemeral CA. Plain HTTP
 * traffic is forwarded directly with the browser UA.
 *
 * Returns the proxy port, the CA certificate PEM (for --cert), and a
 * shutdown function.
 */
export async function startImportProxy(): Promise<ImportProxy> {
    const ca: CABundle = await generateCA();

    // Per-host TLS listener cache: hostname → { listener, port }
    const hostListeners = new Map<string, { listener: Deno.TlsListener; port: number }>();

    async function getHostListener(hostname: string): Promise<{ listener: Deno.TlsListener; port: number }> {
        let entry = hostListeners.get(hostname);
        if (entry) return entry;

        const cert = await generateHostCert(hostname, ca.privateKey, ca.certPem);
        const listener = Deno.listenTls({
            port: 0,
            hostname: "127.0.0.1",
            cert: cert.certPem,
            key: cert.keyPem,
        });
        const port = (listener.addr as Deno.NetAddr).port;
        entry = { listener, port };
        hostListeners.set(hostname, entry);

        // Accept loop for this host's TLS listener.
        (async () => {
            for await (const conn of listener) {
                handleTlsConn(conn, hostname);
            }
        })().catch(() => {});

        return entry;
    }

    // TCP proxy server (accepts CONNECT and plain HTTP).
    const server = net.createServer((socket: net.Socket) => {
        let buf = Buffer.alloc(0);
        const onData = async (data: Buffer) => {
            buf = Buffer.concat([buf, data]);
            const str = buf.toString();
            if (!str.includes("\r\n\r\n")) return;
            socket.removeListener("data", onData);

            if (str.startsWith("CONNECT")) {
                const hostPort = str.split(" ")[1];
                const hostname = hostPort.split(":")[0];

                try {
                    const entry = await getHostListener(hostname);
                    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

                    // Relay bytes between client and local TLS listener.
                    const localConn = await Deno.connect({ hostname: "127.0.0.1", port: entry.port });
                    relay(localConn, socket);
                } catch {
                    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
                    socket.end();
                }
            } else {
                // Plain HTTP — forward with browser UA.
                const firstLine = str.split("\r\n")[0];
                const urlMatch = firstLine.match(/^\w+ (\S+)/);
                if (!urlMatch) {
                    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
                    socket.end();
                    return;
                }

                try {
                    const targetUrl = urlMatch[1];
                    const resp = await fetch(targetUrl, {
                        headers: { "User-Agent": BROWSER_USER_AGENT },
                        redirect: "follow",
                    });
                    const body = await resp.arrayBuffer();
                    const statusLine = `HTTP/1.1 ${resp.status} ${resp.statusText}\r\n`;
                    const headers = [...resp.headers.entries()]
                        .filter(([k]) => k !== "transfer-encoding")
                        .map(([k, v]) => `${k}: ${v}`)
                        .join("\r\n");
                    const responseStr = `${statusLine}${headers}\r\nContent-Length: ${body.byteLength}\r\n\r\n`;
                    socket.write(responseStr);
                    socket.write(Buffer.from(body));
                    socket.end();
                } catch {
                    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
                    socket.end();
                }
            }
        };
        socket.on("data", onData);
    });

    server.listen(0, "127.0.0.1");
    await new Promise<void>(r => server.on("listening", r));
    const proxyPort = (server.address() as net.AddressInfo).port;

    return {
        port: proxyPort,
        caCertPem: ca.certPem,
        shutdown: async () => {
            for (const [, entry] of hostListeners) {
                try { entry.listener.close(); } catch {}
            }
            hostListeners.clear();
            server.close();
        },
    };
}
