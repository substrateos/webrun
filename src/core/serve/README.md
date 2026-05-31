# Serve

HTTP/HTTPS server abstraction for WebRun.

## Why

WebRun needs to serve HTTP in several contexts: the user-facing `ctx.serve`
API, the UA proxy's MITM servers, and future binding endpoints. Each context
needs the same handler shape (`(Request, Context) → Response`) but the
underlying transport varies by platform.

This module defines the platform-agnostic serve contract and provides
adapter implementations for specific runtimes.

## Contract

The core types in `types.ts`:

- **`ServeHandler`** — `(req: Request, ctx: ServeContext) => Response | Promise<Response>`
- **`ServeContext`** — per-request context with optional `upgradeWebSocket` and `upgradeConnect`
- **`ServeOptions`** — listen addresses, TLS config, abort signal
- **`ServeResult`** — resolved URLs and `shutdown()`
- **`ServeFn`** — `(handler, options?) => Promise<ServeResult>`

CONNECT tunnels surface via `upgradeConnect()` which returns Web Streams
(`ReadableStream` / `WritableStream`) for bidirectional piping.

## Files

| File | Role |
|---|---|
| `types.ts` | Platform-agnostic serve contract |
| `node/serve/mod.ts` | `makeServe({ node })` — backed by `node:http` / `node:https` |
