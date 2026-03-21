# [webrun](https://github.com/substrateos/webrun)

`webrun` is a command-line tool for safely running untrusted JavaScript and TypeScript code.

By default, scripts running inside `webrun` are isolated in a sandbox. They cannot access the default network, read or write files on your computer, or view your environment variables. 

To grant a script permission to access specific folders, network domains, or environment variables, you must create a `webrun.json` configuration file (or a `"webrun"` object in your `package.json`) in the script's directory or any parent directory.

## SYNOPSIS
`webrun [options] <script.ts> [args...]`

### Options

- `-h, --help`
  Print the usage instructions.
- `--test`
  Discovers and runs exported functions starting with "test" inside your target script(s) instead of the default export. You can pass multiple scripts (e.g., `webrun --test a.ts b.ts`).
- `--self-test`
  Run the built-in test suite to verify the sandbox is working correctly.
- `--self-bundle`
  Package the `webrun` source files into a single executable file and print to stdout.
- `--self-unbundle <dest>`
  Extract the `webrun` source files from the executable into a folder for editing.

## CONFIGURATION

### Example `webrun.json`

```json
{
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
  }
}
```

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
  // 1. Arguments & Flags
  // ctx.args contains positional command line arguments passed after your script.
  // ctx.flags contains any parsed --flag values.
  // E.g., `webrun my_script.ts --mode debug my_file.txt`
  //   ctx.args[0] === "my_file.txt"
  //   ctx.flags.mode === "debug"
  console.log("Positional Arguments:", ctx.args); 
  console.log("Flags:", ctx.flags); 
  
  // ctx.command is the name/path of the script itself
  console.log("Running script:", ctx.command);

  // 2. Environment Variables
  // You can only access environment variables explicitly allowed in webrun.json.
  console.log("API Key:", ctx.env.API_KEY);

  // 3. File System
  // ctx.storage is a standard W3C StorageManager natively mapping the host file system.
  // It gives you access to specific paths explicitly defined in webrun.json (or package.json),
  // evaluated relative to the folder where the configuration file was found.
  const root = await ctx.storage.getDirectory();
  
  // Create and write to a file:
  const fileHandle = await root.getFileHandle("output.txt", { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write("Hello sandbox!");
  await writable.close();

  // 4. OPFS (Origin Private File System)
  // webrun provides a temporary directory via navigator.storage.getDirectory().
  // This provides an ephemeral, isolated workspace that is destroyed when the script exits.
  const opfsRoot = await navigator.storage.getDirectory();
  const tempFile = await opfsRoot.getFileHandle("temp.txt", { create: true });
}
```

### File System Access
Scripts cannot use standard `fs` or `Deno` globals to interact with the file system. You must use `ctx.storage` (to access the host directory mapped by the configuration) or `navigator.storage` (for temporary sandbox-isolated OPFS storage). If you try to read or write a file outside of the allowed directory, the sandbox will block the operation.

### Testing Scripts
If you run `webrun --test my_script.ts`, `webrun` will look for named exports that begin with `test` and execute them using the native test runner. You can also pass multiple test files at once, such as `webrun --test a.test.ts b.test.ts`, and all discovered test exports will be executed in a combined suite.

```javascript
export async function testMyFunction(t, ctx) {
  // `ctx` is the standard sandbox context (args, flags, env, storage)
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

## SECURITY MODEL

The web browser provides one of the most robust and widely used sandboxes available. It successfully balances the needs of complex applications with user security. `webrun` brings a similar security model to command-line scripts. By using a browser-compatible sandbox, `webrun` is particularly well-suited for running AI-generated code or autonomous agents that need to interact with the filesystem, as it ensures they cannot exceed explicit permissions.

### Threat Model
`webrun` is designed with the assumption that the executed script is actively hostile, whether it is a malfunctioning autonomous agent, the result of a malicious prompt injection, or a compromised dependency.

We design protections against a script attempting to:
1. **Escalate permissions:** All permissions must be explicitly declared in `webrun.json`.
2. **Escape allowed directories:** Native APIs for file system access are disabled. Instead, scripts must use a W3C `StorageManager` API that is restricted to the allowed directories. On macOS, execution is further restricted by a system-level seatbelt profile (`sandbox-exec`).
3. **Modify its own rules:** Scripts cannot write to `webrun.json` configuration files or the `webrun` executable. This prevents a script from expanding its own sandbox.
4. **Exhaust system resources:** The `timeoutMillis` limit prevents infinite loops, and the `memoryMB` limit enforces a strict ceiling on both JavaScript heap and off-heap memory usage.
5. **Exfiltrate data:** Network access is denied by default and must be explicitly allowed for specific domains.
6. **Bypass nested limits:** When configurations are nested, a child directory's configuration can only reduce its permissions compared to its parent's configuration, never increase them.

### Relationship with Deno
`webrun` uses Deno for executing JavaScript and TypeScript. However, it applies a custom, locked-down security model, a browser-like filesystem API, and on macOS, an additional OS-level sandbox. The native `Deno` namespace is removed from the execution environment.

#### Why not use Deno directly?
Deno has an excellent permission system, but it is designed for a scenario where a **trusted user** controls the execution environment and intentionally grants permissions to a program. `webrun` is designed for a scenario where a **untrusted program** controls the execution environment.

If an autonomous agent is running a tool using standard Deno, the agent itself could simply provide command-line flags (like `--allow-all`) to grant itself maximum permissions. By moving configuration into static `webrun.json` files that the script cannot modify, `webrun` prevents the script from changing its own permissions.

Additionally, by providing a W3C `StorageManager` API, scripts written for `webrun` can be run directly in a web browser without modification.

On macOS, we also add an OS-level sandbox (`sandbox-exec`), similar to how Google Chrome operates, which Deno does not do by default.

## RUNTIME AND CACHING

On its first run, `webrun` automatically downloads an isolated Deno runtime and extracts its own TypeScript source code into `~/.cache/webrun/`. This keeps `webrun` completely self-contained, prevents conflicts with any globally installed tools, and keeps your project's working directory clean.
