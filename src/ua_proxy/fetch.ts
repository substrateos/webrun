/**
 * UA Proxy — fetch handler
 *
 * Pure request handler that forwards HTTP requests to upstream
 * with a browser-like User-Agent. Strips encoding headers
 * to prevent double-decompression (fetch() auto-decompresses).
 *
 * This module exports { fetch } — the standard webrun module shape.
 */

import { BROWSER_USER_AGENT } from "../core/ua.ts";

/** Headers stripped from upstream responses: fetch() auto-decompresses. */
const STRIPPED_HEADERS = new Set([
    "transfer-encoding",
    "content-encoding",
    "content-length",
]);

async function proxyFetch(req: Request): Promise<Response> {
    try {
        const upstream = await fetch(req.url, {
            headers: { "User-Agent": BROWSER_USER_AGENT },
            redirect: "follow",
        });

        const body = new Uint8Array(await upstream.arrayBuffer());
        const headers = new Headers();
        for (const [k, v] of upstream.headers.entries()) {
            if (!STRIPPED_HEADERS.has(k)) headers.set(k, v);
        }
        headers.set("content-length", String(body.byteLength));

        return new Response(body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers,
        });
    } catch {
        return new Response(null, { status: 502, statusText: "Bad Gateway" });
    }
}

export default { fetch: proxyFetch };
