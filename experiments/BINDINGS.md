# Bindings

> [!WARNING]
> This is an experimental feature. The API and behavior may change.

Bindings allow a sandboxed guest script to communicate with host-side services through a standard `fetch` interface. The guest never sees the underlying transport — it calls `ctx.bindings.<name>.fetch()` and gets back a `Response`, identical to calling any HTTP API.

## Binding Modes

### Process Bindings

A process binding launches an arbitrary command as a subprocess. The command receives a dynamically allocated port via an environment variable and must start an HTTP server on that port.

```json
{
  "bindings": {
    "my_backend": {
      "process": {
        "command": ["deno", "run", "-A", "backend.ts"],
        "portEnv": "PORT"
      }
    }
  }
}
```

The subprocess implementation:

```typescript
// backend.ts
const port = parseInt(Deno.env.get("PORT") || "0", 10);
Deno.serve({ port, hostname: "127.0.0.1" }, (req) => {
    return new Response("Hello from the backend");
});
```

Process bindings can use any runtime — Deno, Node, Python, Go, a compiled binary — anything that can serve HTTP on a given port.

### Module Bindings

A module binding runs a JavaScript module host-side. The module exports a `fetch` handler following the Cloudflare Workers / Service Worker model. No subprocess is spawned.

```json
{
  "bindings": {
    "ai": {
      "module": "llm.js"
    }
  }
}
```

```javascript
// llm.js
export default {
    async fetch(req) {
        const body = await req.text();
        return new Response("response: " + body, {
            headers: { "X-Custom": "Foo" }
        });
    }
}
```

Module bindings are simpler and faster (no subprocess overhead), but they run in the host's Deno process and are best suited for lightweight adapters.

## Guest API

From the guest's perspective, all bindings — process or module — expose the same interface:

```javascript
export default async function(ctx) {
    // ctx.bindings.<name>.fetch() — identical to the standard fetch API
    const res = await ctx.bindings.my_backend.fetch("/api/data", {
        method: "POST",
        body: JSON.stringify({ query: "hello" }),
        headers: { "Content-Type": "application/json" },
    });

    const data = await res.json();
    console.log(data);
}
```

The guest must declare which bindings it is permitted to use in `permissions.bindings`:

```json
{
  "permissions": {
    "bindings": ["my_backend"]
  },
  "bindings": {
    "my_backend": {
      "process": {
        "command": ["python3", "server.py"],
        "portEnv": "PORT"
      }
    }
  }
}
```

## Binding Permissions

Process bindings accept an optional `permissions` block that controls the subprocess environment:

### Environment Variables

By default, a binding subprocess receives only a minimal base environment (temp dirs, cache paths). To pass specific host environment variables:

```json
{
  "bindings": {
    "api_proxy": {
      "process": {
        "command": ["deno", "run", "-A", "proxy.ts"],
        "portEnv": "PORT",
        "permissions": {
          "env": ["API_KEY", "DEBUG"]
        }
      }
    }
  }
}
```

Without `permissions.env`, host secrets are never visible to the binding.

### Storage

By default, bindings receive read-only access to the current working directory. To grant additional filesystem access:

```json
{
  "bindings": {
    "builder": {
      "process": {
        "command": ["deno", "run", "-A", "build.ts"],
        "portEnv": "PORT",
        "permissions": {
          "storage": {
            ".": { "access": "read" },
            "out": { "access": "write" }
          }
        }
      }
    }
  }
}
```

## Security Model

Binding subprocesses are OS-level sandboxed using the same mechanisms as the main guest:

- **macOS:** Each process binding runs under a dedicated seatbelt profile (`sandbox-exec`) with filesystem, network, and GPU restrictions derived from its declared permissions.
- **Linux:** Each process binding runs under Landlock kernel restrictions. A lightweight wrapper applies `applyLandlockJail()` then `exec`'s into the actual binding command. Since Landlock restrictions are irreversible and survive `exec`, the binding is confined regardless of its runtime.

This means a binding configured with `"command": ["deno", "run", "-A", "script.ts"]` does **not** actually get `-A` (allow-all) capabilities — the OS sandbox restricts it to its declared permission envelope.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Guest (sandboxed)                          │
│                                             │
│  ctx.bindings.my_backend.fetch("/")         │
│       │                                     │
│       ▼                                     │
│  Bearer token injection                     │
└───────┬─────────────────────────────────────┘
        │ HTTP (localhost)
        ▼
┌───────────────────────┐
│  Mux Proxy (host)     │
│  Constant-time token  │
│  auth + streaming     │
│  reverse proxy        │
└───────┬───────────────┘
        │ HTTP (localhost)
        ▼
┌───────────────────────┐
│  Binding Process      │
│  (OS-level sandboxed) │
│  Deno / Node / Python │
│  / any HTTP server    │
└───────────────────────┘
```

The mux proxy:
- Validates bearer tokens using constant-time comparison (no timing side-channels)
- Streams request and response bodies end-to-end without buffering
- Routes by token, not by path — each binding has a unique token
- Strips the `Authorization` header before forwarding to the binding

The guest never learns the binding's actual port. It only knows the mux proxy address and its bearer token. Direct connections to binding ports are blocked.

## Lifecycle

1. **Startup:** Bindings are started before the guest script executes. Each process binding allocates an ephemeral port and begins listening.
2. **Ready:** The mux proxy starts once all bindings have their ports allocated.
3. **Runtime:** The guest calls `ctx.bindings.<name>.fetch()` which routes through the mux proxy.
4. **Shutdown:** When the guest script completes (or is killed), all binding subprocesses are terminated. Zombie processes are forcefully killed.

Exit behavior:
- **Code 0:** Logged as a graceful early exit (green banner).
- **Non-zero code** (excluding signal codes 130/137/141/143): Logged as unexpected termination with the last 15 lines of the binding's log file.
- **Signal codes** (SIGINT, SIGKILL, SIGPIPE, SIGTERM): Silently ignored — these are expected when webrun terminates.

## Airgap Isolation

Bindings interact with the `isolate` system. If a script uses isolated storage paths, bindings are blocked unless the binding itself is explicitly marked as `"isolate": true` in the configuration.
