# UA Proxy

A local MITM HTTPS proxy that sets the `User-Agent` header on outgoing HTTP
requests to a browser-like string.

## Why

CDNs like [esm.sh](https://esm.sh) inspect the `User-Agent` header to decide
which build target to serve. A request from Deno's default UA returns a
Deno-specific build; a request from Chrome returns a browser-targeted ES module
bundle. WebRun needs the browser build — its sandbox implements browser APIs,
not Deno APIs — so every import fetch must carry a browser UA.

Deno does not expose a way to override the `User-Agent` on module import
fetches. The only interception point is `HTTPS_PROXY`: Deno routes all import
traffic through the configured proxy, and the proxy rewrites the UA before
forwarding upstream.

## Architecture

The proxy is a standard `export default { fetch }` handler (`fetch.ts`) wrapped
in a two-server MITM topology:

```
Client ──CONNECT esm.sh:443──→ Front-door (HTTP)
                                  │ upgradeConnect → TCPSocket pipe
                                  ▼
                              TLS server (HTTPS, SNICallback)
                              → forges cert for esm.sh
                              → decrypts request
                              → calls fetch handler
                              → re-encrypts response
                              → back to client

Client ──GET http://...──→ Front-door (HTTP)
                              → calls fetch handler directly
```

CONNECT tunnels are needed because Deno's import system speaks HTTPS. The proxy
terminates TLS using ephemeral certificates signed by a per-session CA (passed
to Deno via `--cert`). The `SNICallback` dynamically generates certs for each
hostname on first contact.

## Platform Independence

This module has **zero platform imports**. All capabilities are injected:

| Dependency | Source | Purpose |
|---|---|---|
| `serve` | Adapter-provided | Listen for HTTP/HTTPS, handle CONNECT |
| `TCPSocket` | `direct_sockets` | Pipe CONNECT tunnels to TLS server |
| `fetch` | Web standard | Forward requests upstream |
| `crypto.subtle` | Web standard | Generate ephemeral TLS certificates |

The Deno adapter wires these by providing its `serve` implementation and a
`TCPSocket` backed by `Deno.connect()`.

## Files

| File | Role |
|---|---|
| `fetch.ts` | `export default { fetch }` — UA-rewriting request handler |
| `tls.ts` | Ephemeral X.509 cert generation (Web Crypto, pure JS ASN.1) |
| `mod.ts` | `startUAProxy({ serve, TCPSocket })` — wiring |
