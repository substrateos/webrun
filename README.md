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
./webrun main.ts
```

## SYNOPSIS
`webrun [options] <script.ts> [args...]`

### Options

- `-h, --help`
  Print the usage instructions.
- `-e, --eval <code>`
  Evaluate the provided inline JavaScript/TypeScript code directly in the sandbox instead of executing a file.
- `--test`
  Discovers and runs exported functions starting with "test" inside your target script(s) instead of the default export. You can pass multiple scripts (e.g., `webrun --test a.ts b.ts`).
- `--self-test`
  Run the built-in test suite to verify the sandbox is working correctly.
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
  // ctx.args contains safely parsed positional arguments specifically intended for your script.
  // ctx.flags contains any parsed --flag values.
  // ctx.argv contains the entire raw execution array including the webrun executable.
  // E.g., `/usr/local/bin/webrun my_script.ts --mode debug my_file.txt`
  //   ctx.args[0] === "my_file.txt"
  //   ctx.flags.mode     === "debug"
  //   ctx.argv[0] === "/usr/local/bin/webrun"
  console.log("Positional Arguments:", ctx.args);
  console.log("Flags:", ctx.flags); 
  console.log("Raw argv:", ctx.argv);
  
  // ctx.command is the name/path of the script itself
  console.log("Running script:", ctx.command);

  // 2. Environment Variables
  // You can only access environment variables explicitly allowed in webrun.json.
  console.log("API Key:", ctx.env.API_KEY);

  // 3. File System
  // ctx.dir is a standard W3C FileSystemDirectoryHandle natively mapping the host file system.
  // It gives you access to specific paths explicitly defined in webrun.json (or package.json),
  // evaluated relative to the folder where the configuration file was found.
  
  // Create and write to a file:
  const fileHandle = await ctx.dir.getFileHandle("output.txt", { create: true });
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

### Spawning Sandboxed Sub-Workers
You can programmatically spawn ephemeral, isolated sub-workers using the `ctx.webrun` API. Sub-workers inherit the exact same security context, memory limits, and timeout constraints as the parent script.

```javascript
export default async function(ctx) {
  // Spawn a child script 
  const result = await ctx.webrun(["src/child.js", "--child-flag", "--", "positional-arg"]);
  
  // Or evaluate code inline
  const evalResult = await ctx.webrun(["--eval", "console.log('Isolated evaluation!');"]);

  if (result.exitCode === 0) {
    console.log("Child output:", result.stdout);
  } else {
    console.error("Child error:", result.stderr);
  }
}
```


### File System Access
Scripts cannot use standard `fs` or other runtime-specific globals to interact with the file system. You must use `ctx.dir` (to access the host directory mapped by the configuration) or `navigator.storage` (for temporary sandbox-isolated OPFS storage). If you try to read or write a file outside of the allowed directory, the sandbox will block the operation.

### Testing Scripts
If you run `webrun --test my_script.ts`, `webrun` will look for named exports that begin with `test` and execute them using the native test runner. You can also pass multiple test files at once, such as `webrun --test a.test.ts b.test.ts`, and all discovered test exports will be executed in a combined suite.

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

## SECURITY MODEL

`webrun` brings a strict browser-style sandbox to the command-line. It balances a simple user experience with the ability to safely host autonomous agents and the code they generate.

### Threat Model
`webrun` assumes the executed script is potentially hostile (e.g., a malfunctioning agent, malicious prompt injection, or compromised dependency).

We design protections against a script attempting to:
1. **Escalate permissions:** All permissions must be explicitly declared in `webrun.json`.
2. **Escape allowed directories:** Native APIs for file system access are disabled. Instead, scripts must use a W3C `StorageManager` API that is restricted to the allowed directories. On macOS, execution is further restricted by a system-level seatbelt profile (`sandbox-exec`).
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

On macOS, we also enforce an OS-level sandbox (`sandbox-exec`), similar to how Google Chrome operates, adding a secondary defense layer missing from default engine configurations.

## RUNTIME AND CACHING

On its first run, `webrun` automatically downloads the isolated Deno engine into `~/.cache/webrun/`. This prevents conflicts with globally installed tools. The bundled `webrun` executable runs completely in-memory or from localized file evaluations cleanly without polluting the host environment.

## MAINTENANCE AND CONTRIBUTING

For information on how the repository is organized, how to update dependencies using native vendoring structures, and instructions on running tests and executing distributions, please refer to the [Maintenance and Contribution Guide](MAINTENANCE.md).
