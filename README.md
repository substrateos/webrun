# [webrun](https://github.com/substrateos/webrun)

## SYNOPSIS
`webrun [options] <script.ts> [args...]`

## DESCRIPTION
`webrun` is a tool for safely running untrusted JavaScript and TypeScript code. 

By default, scripts running inside `webrun` cannot access the internet, read or write files on your computer, or view your environment variables. 

To give a script permission to access specific folders, network domains, or environment variables, you must create a `webrun.json` (or a `"webrun"` object in your `package.json`) configuration file in the current directory or any parent directory.

### Example webrun.json

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

- **`timeoutMillis`**: The maximum number of milliseconds the script is allowed to run. If exceeded (e.g., an infinite loop), it will be forcibly terminated.
- **`memoryMB`**: The maximum allowed memory footprint (in Megabytes). `webrun` natively enforces this as a strict total RSS limit, correctly trapping vast off-heap `ArrayBuffer`/WASM allocations alongside standard JavaScript heap bloat. If memory exceeds this value, the process exits with Linux OOM code `137`.

**Hierarchical Enforcement**: If you nest a `webrun.json` inside a subdirectory, the child configuration is strictly limited by its parents. A child configuration may *narrow* limits (e.g., lower `timeoutMillis` from `5000` to `1000`), but any attempt to expand or escalate them beyond a parent's limit will trigger an immediate security abort.

**Self-Overwrite Protection**: As a core safety mechanism, `webrun` automatically verifies its own executable paths, along with any discovered `webrun.json` and `package.json` configuration files. If a configuration attempts to grant `"write"` access to any directory containing these critical files, execution is immediately aborted with a `SECURITY FATAL` error. This guarantees malicious scripts cannot overwrite the sandbox runner or its boundary definitions.

## CACHING AND RUNTIME DOWNLOADS
On first execution, `webrun` will automatically download an isolated Deno runtime and store it, along with extracted TypeScript code, inside `~/.cache/webrun/`. This ensures the runner is completely self-contained, avoids conflicts with any globally installed tools, and prevents pollution of your project's working tree.

## OPTIONS

- `-h, --help`
  Print the usage instructions.

- `--test`
  Discovers and runs exported functions starting with "test" inside your target script instead of the default export.

- `--self-test`
  Run the built-in test suite to verify the sandbox is working correctly.

- `--self-bundle`
  Package the webrun source files into a single executable file and print to stdout.

- `--self-unbundle <dest>`
  Extract the webrun source files from the executable into a folder for editing.

## IMPORT MAPS
You can supply an `importMap` path in your `webrun.json` to configure module resolution mapping. `webrun` supports standard import maps, but the mapped targets are still subject to your configured permissions.

## API / HOW TO WRITE SCRIPTS

Scripts running in `webrun` typically export a default function. The `ctx` object provides args, flags, env vars, and file system access.

```javascript
export default async function(ctx) {
  // 1. Arguments & Flags
  // ctx.args contains positional command line arguments passed after your script.
  // ctx.flags contains any parsed --flag values.
  // E.g., webrun my_script.ts --mode debug my_file.txt
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

```

### Testing Scripts
If you run `webrun --test my_script.ts`, `webrun` will look for named exports that begin with `test` and execute them using the native test runner.

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

### File System Access
Scripts cannot use standard `fs` or `Deno` globals to interact with the file system. You must use `ctx.storage` mapping your host directory, or `navigator.storage` for temporary sandbox-isolated OPFS storage. If you try to read or write a file outside of the allowed directory, the sandbox will block it.
