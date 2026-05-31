# Architecture

`webrun` is a sandboxed JavaScript/TypeScript execution engine layered on top of Deno. Its design separates concerns into three distinct rings: an outer host shell, a trusted supervisor process, and an isolated guest context.

## Layers at a Glance

```
┌─────────────────────────────────────────────┐
│  Host Shell  (webrun bash wrapper)           │
│   • Locates local Deno cache                 │
│   • Bootstraps environment variables         │
└───────────────────┬─────────────────────────┘
                    │ exec
┌───────────────────▼─────────────────────────┐
│  Supervisor  (webrun.ts / src/*.ts)          │
│   • Config resolution & privilege narrowing  │
│   • Spawns inner process via sandbox-exec    │
│   • Hosts UDP relay for WebRTC               │
└───────────────────┬─────────────────────────┘
                    │ spawn (sandbox-exec on macOS, Landlock on Linux)
┌───────────────────▼─────────────────────────┐
│  Guest Process  (inner Deno)                 │
│   • Deno runtime with --allow-read/write     │
│   • Navigator / Worker / fetch globals only  │
│   • All Deno, process, Buffer globals wiped  │
│   • Guest code executes here                 │
└─────────────────────────────────────────────┘
```

## Source Map

```
src/
  core/                        # Base environment capabilities (config, fs, ipc, logging, running)
  deno/                        # Deno-specific runtime implementations and extensions
  extensions/                  # Shared extension middleware (e.g. OPFS)
  internal/                    # Internal polyfills and shims (e.g. WebRTC overrides)
  ipc/                         # Inter-process communication and remote execution coordination
  node/                        # Node.js runtime implementations
  ua_proxy/                    # MITM HTTPS proxy for browser-like User-Agent masking
bundle/
  webrun.ts                    # Root CLI entrypoint script
```

## Process Model

### 1. Bash Wrapper (`webrun`)

The `webrun` executable is a self-contained Bash script. On first run it downloads Deno into `~/.cache/webrun/deno/` and re-invokes itself using the pinned binary. It sets `WEBRUN_BIN` and `WEBRUN_VERSION` before exec-ing the Deno supervisor.

### 2. Supervisor (`bundle/webrun.ts` & `src/ipc/spawner.ts`)

The supervisor runs with full host permissions. It:

1. **Resolves configuration** — walks from the target script's directory to the filesystem root, collecting all `webrun.json` / `package.json#webrun` files and merging them with privilege narrowing.
2. **Builds the sandbox** — computes runtime `--allow-read/write` flags, generates an import map, and sets up OS jail profiles.
3. **Writes a payload file** — serialises a `SandboxContextPayload` JSON blob to a temp file and passes its path to the inner process.
4. **Spawns the inner process** — uses `src/ipc/spawner.ts` which spawns the child process and transfers I/O pipes via UDS (Unix Domain Sockets) and SCM_RIGHTS.
5. **Hosts the UDP relay** — opens host-side Deno datagram sockets and bridges them over a `MessageChannel` to the guest's WebRTC stack.

### 3. Guest Process

The inner Deno process reads the payload file, then:

1. **Installs sandbox globals** — `navigator.storage`, `performance.memory`, a sandboxed `Worker`, and the fetch proxy.
2. **Wires context methods** — `ctx.makeTempDir` (backed by a temp UUID), `ctx.upgradeWebSocket` (Deno WebSocket upgrade, serve-mode only), and `ctx.TCPSocket`.
3. **Wipes non-web globals** — `Deno`, `process`, `Buffer`, `global`, `setImmediate`.  
   (WebRTC mode preserves a frozen minimal `Deno` stub with `networkInterfaces` only; keeps `Buffer` because werift needs it.)
4. **Imports and runs the guest module** via a dynamic `import(targetUrl)`.

## Security Stack

Four enforcement layers operate independently, so defeating one does not defeat the rest:

| Layer | Mechanism | What It Prevents |
|---|---|---|
| **Configuration** | `webrun.json` privilege narrowing | Scripts expanding their own permissions |
| **Deno flags** | `--allow-read/write` scoped to declared paths | Host file system access outside declared paths |
| **OS seatbelt** | macOS `sandbox-exec` profile | Network exfiltration, process forks, file access beyond declared paths |
| **Landlock** | Linux kernel self-sandboxing (ABI 1–5) via FFI | File system and network access beyond declared paths; restrictions are irreversible and inherited by child processes |
| **Global scrubbing** | Delete `Deno`, `process`, `Buffer` | Runtime API escape hatches |
| **Subprocess jailing** | Seatbelt profiles for supervisor subprocesses (e.g. `git`) | Hostile binary replacement, network exfiltration via toolchain |
| **Mode gating** | Context methods restricted by execution mode | `upgradeWebSocket` only works in `--serve` mode |

### Configuration Protection

`webrun` refuses to grant write access to any directory containing `webrun.json`, `package.json`, or any `importMap` file. This prevents a script from silently rewriting its own sandbox rules.

### Privilege Narrowing

When multiple `webrun.json` files exist in a directory hierarchy, child configs are intersected with parent configs. Attempting to expand a limit (e.g. raising `timeoutMillis` beyond the parent's value) causes immediate abort.

### Import Map Security

Import maps are merged hierarchically (child overrides parent) but are always protected from modification. They may not reside in any directory the sandbox has write access to.

## WebRTC Architecture

WebRTC (via the `werift` library) requires UDP socket access, which is blocked in all guest code. The design tunnels UDP through a `MessageChannel` IPC bridge:

```
Guest (werift)
  └─ ipc_dgram_proxy.ts      [node:dgram polyfill]
       │  postMessage("bind" / "send")
       ▼
MessageChannel (Transferable)
       │
       ▼
Supervisor (webrun.ts)
  └─ setupUdpRelay()
       └─ Deno.listenDatagram()   [real UDP, loopback or external]
```

Key implementation details:

- **Build-time alias** — esbuild replaces `import "dgram"` / `import "node:dgram"` in werift with our IPC proxy.
- **One-shot initialization** — `__initStrictUdpChannel(port)` self-destructs after wiring; guest code cannot re-invoke it.
- **Buffer correctness** — The proxy emits `Buffer.from(payload)` (not `Uint8Array`) because werift calls `.readUint16BE()` on incoming STUN data.
- **Packet integrity** — `conn.receive()` returns a view into a 65507-byte pre-allocated receive buffer; `data.slice(0, data.byteLength)` extracts only the actual packet bytes before transfer.
- **Sandbox STUN patches** — werift's hardcoded Google STUN fallbacks are patched out since the OS seatbelt blocks outbound UDP to external hosts.

## Data Flow: Normal Script Execution

```
webrun --module script.ts
  │
  ▼  Supervisor / Broker
  1. findLocalConfigurations()     ← discover webrun.json chain
  2. validatePrivilegeNarrowing()  ← intersect parent/child limits
  3. evaluateEnclavePolicy()       ← compute allowed read/write paths
  4. generateSeatbeltProfile()     ← build OS jail profile
  5. buildRuntimeArgs()            ← compute --allow-net, --allow-read, etc.
  6. Write SandboxContextPayload   → /tmp/.../payload.json
  7. spawn: invoke src/ipc/spawner.ts to broker child process and transfer IO
  │
  ▼  Guest Process
  8. Read payload.json
  9. setupUdpRelay()
 10. executeInsideSandbox()
      a. createStorageManager()    ← mount ctx.dir
      b. setupSandboxGlobals()     ← install navigator.storage, Worker, etc.
      c. setupFetchProxy()         ← enforce network allow-list
      d. wire ctx.makeTempDir      ← FileSystemDirectoryHandle over runnerTmp/<uuid>
      e. wire ctx.upgradeWebSocket ← gated to serve mode
      f. wire ctx.TCPSocket        ← Direct Sockets API
      g. wire ctx.tty              ← PTY mode control (when stdin is a terminal)
      h. delete Deno / process     ← wipe escape hatches
      i. import(targetUrl)         ← run guest code
     [j. bootstrapWebRTC(port)]    ← wire werift (if WebRTC enabled)
```

### Test Mode

In test mode (`--test[=filter]`), the guest process discovers exported functions starting with `test` from one or more modules and executes them using the internal test harness. When multiple modules are provided as positional args (`--test a.test.ts b.test.ts`), all are loaded and their test exports merged. An optional inline filter (`--test=pattern`) applies at two levels: top-level (skipping entire test exports whose name doesn't match, when any top-level name does match) and sub-step (skipping sub-tests inside `t.run()` calls).

## OPFS Persistence

By default, `navigator.storage.getDirectory()` returns an ephemeral directory (`webrun_opfs_*` in the system temp dir) that is deleted on exit. When `experimental.opfs` is configured, the OPFS root is mapped to a persistent location at `~/.webrun/opfs/<strategy>/<id>/fs/`.

### Strategy Resolution

| Strategy | ID Derivation | Supervisor Behavior |
|---|---|---|
| `"git"` | First root commit hash (`git rev-list --max-parents=0 HEAD`) | Git subprocess runs inside a macOS seatbelt jail that denies network access and all writes except the xcrun cache. Uses `/usr/bin/git` absolute path with `clearEnv: true`. |
| `"path"` | Base64 of canonicalized `configDir` (via `realPathSync`) | No subprocess required |

### Audit Logging

Every execution against a persistent OPFS bucket appends a single NDJSON line to `~/.webrun/opfs/<strategy>/<id>/audit.ndjson` using OS-level `appendTextFileSync` (atomic append, no read-then-rewrite):

```json
{"timestamp":"2026-04-10T12:00:00.000Z","configPath":"/path/to/webrun.json","args":["--module","main.ts"]}
```

### Sandbox Boundaries

| Directory | Deno Permissions | Seatbelt | Cleaned Up |
|---|---|---|---|
| `runnerTmp` | read + write | read + write enclave | Always (on exit) |
| `opfsTmp` (ephemeral) | read + write | write enclave | Always (on exit) |
| `opfsTmp` (persistent) | read + write | write enclave | Never |

`ctx.makeTempDir()` creates directories inside `runnerTmp`, so they are always cleaned up on exit regardless of OPFS persistence mode.

## Shared Runs

Shared runs (`{ shared: true }` in `ctx.run()` options) deduplicate long-lived child processes by resolved target path — following SharedWorker-style semantics. The first call spawns the process; subsequent calls return a handle to the existing instance.

```js
const h1 = await ctx.run(["--serve", import.meta.resolve("./api.js")], { shared: true });
const h2 = await ctx.run(["--serve", import.meta.resolve("./api.js")], { shared: true });
// h1 and h2 reference the same process — same urls, same exitCode
```

### Constraints

- `shared: true` forbids all other options (env, dir, permissions, limits, stdin, signal, etc.)
- The returned handle is a service locator: only `urls` and `exitCode` are meaningful
- `stdout` and `stderr` are empty closed streams
- `signal()` is a no-op — lifecycle is scope-managed

### Deduplication

A `SharedRegistry` maps resolved target paths to live `RunHandle` instances. When the handle's `exitCode` settles, the entry is automatically evicted, allowing fresh spawns on the next call. Each sandbox and host creates its own registry, scoping deduplication to the server process.

### Config Discovery

Shared runs use standard config discovery — `findLocalConfigurations` walks from the context directory to find `webrun.json` files. The caller's config chain determines permissions and limits. The target's own config participates through the standard location chain mechanism.

