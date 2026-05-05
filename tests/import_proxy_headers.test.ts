// import_proxy_headers.test.ts — Unit tests for proxy response header serialization.
//
// Verifies that serializeProxyResponseHeaders correctly strips encoding
// and hop-by-hop headers to prevent double-decompression when proxying
// gzip-encoded upstream responses.

import { serializeProxyResponseHeaders } from "../src/import_proxy.ts";

// =========================================================
// Table-driven tests for header filtering
// =========================================================

const headerCases: {
    name: string;
    upstream: [string, string][];
    bodySize: number;
    mustNotContain: string[];
    mustContain: string[];
}[] = [
    {
        name: "strips content-encoding to prevent double-decompression",
        upstream: [
            ["content-type", "application/javascript; charset=utf-8"],
            ["content-encoding", "gzip"],
            ["cache-control", "public, max-age=31536000, immutable"],
        ],
        bodySize: 4096,
        mustNotContain: ["content-encoding"],
        mustContain: ["content-type: application/javascript", "Content-Length: 4096"],
    },
    {
        name: "strips transfer-encoding (hop-by-hop)",
        upstream: [
            ["content-type", "text/plain"],
            ["transfer-encoding", "chunked"],
        ],
        bodySize: 100,
        mustNotContain: ["transfer-encoding"],
        mustContain: ["Content-Length: 100"],
    },
    {
        name: "strips upstream content-length to avoid mismatch with decompressed body",
        upstream: [
            ["content-type", "application/javascript"],
            ["content-encoding", "br"],
            ["content-length", "512"],
        ],
        bodySize: 2048,
        mustNotContain: ["content-encoding", "content-length: 512"],
        mustContain: ["Content-Length: 2048"],
    },
    {
        name: "preserves non-encoding headers",
        upstream: [
            ["content-type", "application/javascript"],
            ["cache-control", "public, max-age=31536000"],
            ["access-control-allow-origin", "*"],
            ["x-custom", "value"],
        ],
        bodySize: 1024,
        mustNotContain: [],
        mustContain: [
            "content-type: application/javascript",
            "cache-control: public",
            "access-control-allow-origin: *",
            "x-custom: value",
            "Content-Length: 1024",
        ],
    },
    {
        name: "esm.sh gzip response: full CDN header set",
        upstream: [
            ["content-type", "application/javascript; charset=utf-8"],
            ["access-control-allow-origin", "*"],
            ["cache-control", "public, max-age=31536000, immutable"],
            ["content-encoding", "gzip"],
            ["vary", "Accept-Encoding"],
            ["cf-cache-status", "HIT"],
        ],
        bodySize: 8192,
        mustNotContain: ["content-encoding"],
        mustContain: [
            "HTTP/1.1 200 OK",
            "content-type: application/javascript; charset=utf-8",
            "Content-Length: 8192",
            "cache-control: public",
        ],
    },
];

export async function testProxyHeaderSerialization(t: any) {
    for (const c of headerCases) {
        await t.run(c.name, async () => {
            const upstream = new Headers(c.upstream);
            const result = serializeProxyResponseHeaders(200, "OK", upstream, c.bodySize);

            for (const banned of c.mustNotContain) {
                if (result.toLowerCase().includes(banned.toLowerCase())) {
                    throw new Error(
                        `Response must NOT contain '${banned}' but got:\n${result}`
                    );
                }
            }

            for (const required of c.mustContain) {
                if (!result.includes(required)) {
                    throw new Error(
                        `Response must contain '${required}' but got:\n${result}`
                    );
                }
            }
        });
    }
}
