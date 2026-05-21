/**
 * Serializes upstream response headers for proxied delivery.
 * Strips hop-by-hop headers and produces a complete HTTP/1.1 header block
 * with an accurate Content-Length for the (already decompressed) body.
 */
export function serializeProxyResponseHeaders(
    status: number,
    statusText: string,
    upstreamHeaders: Headers,
    bodyByteLength: number,
): string {
    // Omit hop-by-hop and encoding headers: fetch() auto-decompresses
    // gzip/br, so forwarding content-encoding would cause double-decode.
    // Content-length is recomputed from the actual (decompressed) body.
    const stripped = new Set(["transfer-encoding", "content-encoding", "content-length"]);
    const headers = [...upstreamHeaders.entries()]
        .filter(([k]) => !stripped.has(k))
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
    return `HTTP/1.1 ${status} ${statusText}\r\n${headers}\r\nContent-Length: ${bodyByteLength}\r\n\r\n`;
}
