# [webrun](https://github.com/substrateos/webrun)

`webrun` is a command-line tool for safely running untrusted JavaScript and TypeScript code.

> [!WARNING]
> `webrun` is currently **experimental**. While it utilizes strict OS-level constraints and runtime sandboxing, you should vet it heavily for your specific use-case before depending on it in a production environment.

By default, scripts running inside `webrun` are isolated in a sandbox. They cannot access the default network, read or write files on your computer, or view your environment variables. 

To grant a script permission to access specific folders, network domains, or environment variables, you must create a `webrun.json` configuration file (or a `"webrun"` object in your `package.json`) in the script's directory or any parent directory.

## INSTALLATION

Download and commit the `webrun` executable directly into your repository. The same executable works on both macOS and Linux:

```bash
curl -fsSL https://github.com/substrateos/webrun/releases/latest/download/webrun-dist > ./webrun
chmod +x ./webrun

# After inspecting the downloaded file, run the built-in test suite:
./webrun --self-test
```

## QUICKSTART

To run scripts safely, you must define sandbox boundaries in a `webrun.json` file. 

By default, the sandbox is entirely isolated in an ephemeral temporary folder. To grant the script permission to read files in the current directory (`.`), create a `webrun.json` like this:

```json
{
  "permissions": {
    "storage": {
      ".": { "access": "read" }
    }
  }
}
```

Create a script `main.ts` that uses the sandbox context object (`ctx`) to read a file using standard Web API `FileSystemDirectoryHandle` methods:

```typescript
// main.ts
export default async function(ctx: any) {
    // ctx.dir points to your sandboxed storage root
    try {
        const fileHandle = await ctx.dir.getFileHandle("hello.txt");
        const file = await fileHandle.getFile();
        console.log("File contents:", await file.text());
    } catch (err: any) {
        console.error("Failed to read file:", err.name);
    }
}
```

Create a test `hello.txt` file in the same directory:

```bash
echo "Hello from the sandbox!" > hello.txt
```

Finally, run the script securely through `webrun`:

```bash
./webrun --module main.ts
```

## SYNOPSIS
`webrun [options] [args...]`

### Options

- `-h, --help`
  Print the usage instructions.
- `-e, --eval <code>`
  Evaluate the provided inline JavaScript/TypeScript code directly in the sandbox instead of executing a module.
- `--module <name>`
  Explicitly set the execution entrypoint using a module specifier or import map alias.
- `--test[=<filter>]`
  Run test suites. Discovers and runs exported functions starting with "test" inside your target script instead of the default export. Optionally filter by name substring. Supports multiple modules as positional args (e.g., `webrun --test a.test.ts b.test.ts`).
- `--serve`
  Start an HTTP server that routes requests to the target module's `fetch` handler. If the target is a directory, serves static files. See [Serving](#serving) for details.
- `--bind=<host>:<port>`
  Bind the server to a specific address (used with `--serve`). Examples: `--bind=127.0.0.1:8080`, `--bind=:3000`, `--bind=0.0.0.0`. Multiple `--bind` flags create multiple listeners. Defaults to `127.0.0.1` on a random port.
- `--self-test[=<filter>]`
  Run the built-in test suite to verify the sandbox is working correctly. Optionally filter by suite name substring.
- `--self-bundle`
  Package the `webrun` source files into a single executable file and print to stdout.
- `--self-vendor`
  Cache and vendor all external dependencies natively within the repository for offline accessibility.
- `--self-unbundle <dest>`
  Extract the `webrun` source files from the executable into a folder for editing.

## CONFIGURATION

### Example `webrun.json`

```json
{
  "module": "src/main.ts",
  "serve": "src/server.ts",
  "limits": {
    "timeoutMillis": 120000,
    "memoryMB": 512
  },
  "importMap": "import_map.json",
  "permissions": {
    "storage": {
      ".": { "access": "read" },
      "out/": { "access": "write" }
    },
    "network": [
      "github.com"
    ],
    "env": [
      "API_KEY",
      "DEBUG_MODE"
    ]
  },
  "experimental": {
    "opfs": { "origin": "git" }
  }
}
```

#### Permission Wildcards

Use `"*"` to grant unrestricted access for a permission axis:

- **`"network": ["*"]`** — Allows outgoing requests to any domain (SSRF protection for private IP ranges is still enforced).
- **`"env": ["*"]`** — Injects all host environment variables into the sandbox.

### Default Module and Sandboxing
You can omit explicit targeting flags (`--module`) when executing `webrun` from the command line if you define a `"module"` property in your `webrun.json`. `webrun` will automatically discover and execute this default entrypoint.

### Sandbox Limits
You can strictly bound the execution of any untrusted script using the `limits` object.

- **`timeoutMillis`**: The maximum number of milliseconds the script is allowed to run. If exceeded (e.g., due to an infinite loop), it will be forcibly terminated.
- **`memoryMB`**: The maximum allowed memory footprint (in megabytes). `webrun` enforces this as a strict total RSS limit, which includes both the standard JavaScript heap and off-heap allocations like `ArrayBuffer` and WebAssembly memory. If memory usage exceeds this value, the process immediately exits.

**Hierarchical configuration**: If you place a `webrun.json` inside a subdirectory, the child configuration is still bound by its parents. A child configuration can *reduce* limits (e.g., lowering `timeoutMillis` from `5000` to `1000`), but it cannot increase them beyond what the parent configuration allows. Attempting to expand permissions or limits beyond a parent's scope will cause the script to abort.

**Configuration protection**: `webrun` prevents scripts from modifying its configuration files (`webrun.json`, `package.json`, and referenced `importMap` files) or the `webrun` executable itself. If a configuration tries to grant write access to a directory containing these essential files, execution aborts immediately. This ensures that a script cannot rewrite its own sandbox rules.

### Import Maps
You can specify an `importMap` path in your `webrun.json` to configure module resolution. `webrun` handles import maps with two specific behaviors:

1. **Hierarchical merging**: If a child directory has an `import_map.json`, `webrun` merges it with all parent import maps, with the child taking precedence. This is useful for monorepos where a root map defines shared libraries, while child directories can override them or add local utilities.
2. **Protection**: Import map files are protected from modification by the sandbox. They cannot be located in a directory that the sandbox has write access to.

## SCRIPT IMPLEMENTATION

Scripts running in `webrun` typically export a default function. The `ctx` object provides parsed arguments, flags, environment variables, and file system access.

```javascript
export default async function(ctx) {
  // Parsing & Execution Context
  // E.g. `/usr/local/bin/webrun script.js --mode debug file.txt`
  console.log("Target:", ctx.command); // "script.js"
  console.log("Args:", ctx.args);      // ["file.txt"] 
  console.log("Flags:", ctx.flags);    // { mode: "debug" }
  console.log("Raw argv:", ctx.argv);  // ["/usr/local/bin/webrun", "script.js", ...]
  
  console.log("Env:", ctx.env.TOKEN);  // Requires webrun.json allowlist
  
  // File System Access (evaluates relative to the webrun.json location)
  const file = await ctx.dir.getFileHandle("out.txt", { create: true });
  const writable = await file.createWritable();
  await writable.write("Hello safely!");
  await writable.close();

  // OPFS workspace (ephemeral by default, see Persistent OPFS)
  const opfs = await navigator.storage.getDirectory();
  await opfs.getFileHandle("temp.txt", { create: true });

  // Temporary directories (W3C FileSystemDirectoryHandle, cleaned up on exit)
  const tmpDir = await ctx.makeTempDir();
  const tmpFile = await tmpDir.getFileHandle("scratch.txt", { create: true });

  // Spawn isolated child sandboxes with flags and arguments
  const child = await ctx.webrun(["--module", "child.js", "--child-flag", "--", "arg"]);
  console.log(child.exitCode, child.stdout, child.stderr);

  // Or evaluate code inline
  const inline = await ctx.webrun(["--eval", "console.log('Isolated!')"]);

  // Graceful signals and exits
  ctx.signal.addEventListener("abort", () => console.log("Caught SIGTERM/SIGINT"));
  // ctx.exit(0);
}
```

Context methods are also available as named imports from `webrun/ctx`:

```javascript
import { makeTempDir, upgradeWebSocket, tty } from "webrun/ctx";
```

### Terminal Control

When stdin is connected to a terminal (TTY), `ctx.tty` provides control over the PTY mode:

```javascript
export default async function(ctx) {
    if (ctx.tty) {
        await ctx.tty.setRawMode(true);    // character-at-a-time input
        try {
            // Read raw keystrokes from ctx.stdin
            // Write ANSI rendering to ctx.stdout
        } finally {
            await ctx.tty.setRawMode(false); // restore line-buffered mode
        }
    }
}
```

`ctx.tty` is `undefined` when stdin is piped or in non-interactive contexts.

| Member | Type | Description |
|---|---|---|
| `setRawMode(raw)` | `(boolean) → Promise<void>` | Enable/disable raw mode. Signal generation (Ctrl-C) is preserved. |
| `isRaw` | `boolean` | Current mode state. |
| `columns` | `number` | Terminal width in characters. |
| `rows` | `number` | Terminal height in characters. |

**Cleanup guarantee:** webrun automatically restores cooked mode when the script exits, even if it throws an exception.

### File System Access
Scripts cannot use standard `fs` or other runtime-specific globals to interact with the file system. You must use `ctx.dir` (to access the host directory mapped by the configuration) or `navigator.storage` (for OPFS storage). If you try to read or write a file outside of the allowed directory, the sandbox will block the operation.

### Temporary Directories
`ctx.makeTempDir()` returns a W3C `FileSystemDirectoryHandle` backed by an ephemeral directory that is automatically cleaned up when the process exits. Each call returns an independent directory. This is useful for build artifacts, caches, or any scratch space that should not persist.

```javascript
import { makeTempDir } from "webrun/ctx";

export default async function() {
    const tmp = await makeTempDir();
    const fh = await tmp.getFileHandle("build.log", { create: true });
    // ...
}
```

### Persistent OPFS
By default, `navigator.storage.getDirectory()` returns an ephemeral OPFS workspace that is destroyed when the process exits. To persist data across runs, add an `experimental.opfs` section to your `webrun.json`:

```json
{
  "experimental": {
    "opfs": { "origin": "git" }
  }
}
```

Two origin strategies are supported:

| Strategy | ID Derivation | Use Case |
|---|---|---|
| `"git"` | Root commit hash of the git repository | Shared workspace across clones of the same repo |
| `"path"` | Canonical filesystem path of the config directory | Per-directory workspace |

Persistent OPFS data is stored at `~/.webrun/opfs/<strategy>/<id>/fs/`. An `audit.ndjson` log in the same directory records every execution session (timestamp, arguments, config path) that accesses the persistent workspace.

### Testing Scripts
If you run `webrun --test --module my_script.ts`, `webrun` will look for named exports that begin with `test` and execute them using the native test runner.

```bash
# Single module
./webrun --test --module tests/my_test.ts

# Multiple modules as positional args
./webrun --test tests/a.test.ts tests/b.test.ts

# With inline filter
./webrun --test=specific_test --module tests/my_test.ts
```

```javascript
export async function testMyFunction(t, ctx) {
  // `ctx` is the standard sandbox context (args, flags, env, dir)
  // `t` is a sandbox-safe test adapter providing the following API:
  
  t.log("Starting test for:", t.name);
  
  // Basic assertions
  t.assert(1 === 1, "Math should work");
  
  // Explicit failure or skipping
  if (ctx.flags.fast) {
    t.skip("Skipping heavy test because --fast was passed");
  }
  
  // Nested sub-tests
  await t.run("Sub-test", async (subT) => {
    subT.assert(true, "Nested assertion");
  });
}
```

### Serving

The `--serve` flag starts an HTTP server that routes incoming requests to your module's `fetch` handler, following the Cloudflare Workers / Service Worker model:

```javascript
// server.js
export default {
    async fetch(req, env, ctx) {
        return new Response("Hello from webrun!");
    }
}
```

```bash
./webrun --serve --bind=127.0.0.1:8080 --module server.js
```

If the target is a directory (or no `fetch` handler is exported), `webrun` serves static files from the target path. You can define a default serve entrypoint with the `"serve"` field in `webrun.json`.

#### WebSocket Upgrades

Inside a `--serve` handler, you can upgrade HTTP requests to WebSocket connections using `ctx.upgradeWebSocket()`:

```javascript
import { upgradeWebSocket } from "webrun/ctx";

export default {
    async fetch(req) {
        if (req.headers.get("upgrade") === "websocket") {
            const { socket, response } = upgradeWebSocket(req);
            socket.onmessage = (e) => socket.send("echo: " + e.data);
            return response;
        }
        return new Response("OK");
    }
}
```

> [!NOTE]
> `upgradeWebSocket` is only available in `--serve` mode. Calling it in `--module` or `--eval` mode throws a clear error.

### Web API Runtime Environment
`webrun` executes your code within a pristine, standardized Web API environment. It is explicitly designed to behave identically to a modern browser context:
- **Pure Web Globals:** `webrun` strictly exposes standard W3C browser globals. Server-side capabilities and compatibility layers (like `process`, `Buffer`, or `Deno`) do not exist. Polyglot libraries and WASM bundles correctly detect that they are running in a browser.
- **Performance Profiling:** Standard browser diagnostics like `performance.memory` (V8 capabilities) and the W3C `performance.measureMemory()` spec are fully supported for measuring cross-origin heap allocations natively.
- **Browser-Targeted CDNs:** `webrun` requests external HTTP modules exactly like a modern browser. Intelligent CDNs (such as `esm.sh` or `unpkg`) correctly serve standard browser ES modules rather than injecting Node.js fallback polyfills.

## SECURITY MODEL

`webrun` brings a strict browser-style sandbox to the command-line. It balances a simple user experience with the ability to safely host autonomous agents and the code they generate.

### Threat Model
`webrun` assumes the executed script is potentially hostile (e.g., a malfunctioning agent, malicious prompt injection, or compromised dependency).

We design protections against a script attempting to:
1. **Escalate permissions:** All permissions must be explicitly declared in `webrun.json`.
2. **Escape allowed directories:** Scripts must use a W3C `StorageManager` API that is restricted to the allowed directories. On macOS, execution is further restricted by a system-level seatbelt profile (`sandbox-exec`). On Linux, `webrun` applies irreversible Landlock restrictions to the process before any untrusted code executes.
3. **Modify its own rules:** Scripts cannot write to `webrun.json` configuration files or the `webrun` executable. This prevents a script from expanding its own sandbox.
4. **Exhaust system resources:** The `timeoutMillis` limit prevents infinite loops, and the `memoryMB` limit enforces a strict ceiling on both JavaScript heap and off-heap memory usage.
5. **Exfiltrate data:** Network access is denied by default and must be explicitly allowed for specific domains.
6. **Bypass nested limits:** When configurations are nested, a child directory's configuration can only reduce its permissions compared to its parent's configuration, never increase them.

### Design Rationale

`webrun` uses Deno for execution, but enforces a browser-compatible environment (which means the `Deno` API namespace *is not available* to user scripts).

#### Why not use an existing runtime directly?

Existing runtimes like Deno have excellent permission systems, but they assume a **trusted user** launches the program. In contrast, `webrun` assumes an **untrusted program** is launching it.

If an autonomous agent runs a tool using an existing runtime, it can use a flag like `--allow-all` to disable the sandbox. By moving configuration into a `webrun.json` that the script cannot modify, `webrun` prevents a program from modifying or disabling its own sandbox.

Additionally, by providing a standard W3C `FileSystemDirectoryHandle` API to access the filesystem, scripts written for `webrun` can run directly in a web browser without modification.

On macOS, we also enforce an OS-level sandbox (`sandbox-exec`), similar to how Google Chrome operates. On Linux, we apply Landlock kernel restrictions (ABI 1–5) via FFI, which are irreversible once applied. Both add a secondary defense layer missing from default engine configurations.

#### Layered Network Defense

Network enforcement operates as two composing layers:

1. **Runtime permission flags** (inner layer): Per-host filtering. The `permissions.network` list restricts which specific hosts the script can reach.
2. **OS sandbox** (outer layer): Binary network gating. When `permissions.network` is empty, the OS-level sandbox (seatbelt on macOS, Landlock on Linux) blocks all outbound TCP and UDP at the kernel level, regardless of the runtime's state. When network permissions exist, the OS sandbox opens outbound access and defers host-level filtering to the runtime.

Neither macOS seatbelt nor Linux Landlock support per-host network filtering — the seatbelt accepts only `*` or `localhost` as host values, and Landlock restricts by port only (ABI ≥ 4, TCP only). The OS sandbox provides defense-in-depth for the zero-network case: even if the runtime has a vulnerability, a script with no declared network permissions cannot reach the network.

## RUNTIME AND CACHING

On its first run, `webrun` automatically downloads the isolated Deno engine into `~/.cache/webrun/`. This prevents conflicts with globally installed tools. The bundled `webrun` executable runs completely in-memory or from localized file evaluations cleanly without polluting the host environment.

## MAINTENANCE AND CONTRIBUTING

For information on how the repository is organized, how to update dependencies using native vendoring structures, and instructions on running tests and executing distributions, please refer to the [Maintenance and Contribution Guide](MAINTENANCE.md).
