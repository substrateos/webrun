export interface TestCase {
    name: string;

    /** Executable sandbox payload closure or raw ES module string evaluating against `ctx` natively */
    scripts?: Record<string, string | ((ctx: any) => Promise<void>)>;

    /** Define a virtual file tree for the project root before running the script */
    files?: Record<string, string>;

    /**
     * Optional configuration file(s) to write to the test environment.
     * The key should be the directory path relative to the test root (e.g. "." or "child").
     * The value should be the JSON configuration.
     */
    configs?: Record<string, any>;

    /** Specific environment variables to inject into the host execution context */
    env?: Record<string, string>;

    /** Specific command line arguments to forward via the explicit parameter vector */
    args?: string[];

    /** Specific PWD sub-directory relative to the test root to invoke the worker from */
    cwd?: string;

    /** Hook to perform actions in runDir before execution */
    preflight?: (runDir: string) => Promise<void>;

    /** Expected sandbox boundary assertions */
    expectCode: number | "nonzero";
    expectStdout?: string;
    expectStderr?: string | string[];
}

export async function testSandboxIsolation(tc: any) {
    const Deno = tc.Deno;
    const WORKER_BIN = tc.WORKER_BIN;
    const join = (await import("https://deno.land/std@0.224.0/path/mod.ts")).join;
    const dirname = (await import("https://deno.land/std@0.224.0/path/mod.ts")).dirname;
    const assertEquals = (await import("https://deno.land/std@0.224.0/assert/mod.ts")).assertEquals;
    const assertStringIncludes = (await import("https://deno.land/std@0.224.0/assert/mod.ts")).assertStringIncludes;

    const tests: TestCase[] = [
    {
        name: "[File System] Blocks read outside enclave (/etc/passwd)",
        args: ["src/test.js"],
        scripts: {
            "src/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                if (typeof Deno !== 'undefined') {
                    try { Deno.readTextFileSync("/etc/passwd"); }
                    catch (e: any) { console.error("BLOCKED:", e.message); throw e; }
                } else {
                    console.error("BLOCKED: Runtime does not support file APIs");
                    throw new Error("Fallback block");
                }
            }
        },
        expectCode: 1,
        expectStderr: "BLOCKED:"
    },
    {
        name: "[File System / StorageManager] Blocks write outside enclave (/tmp/escape)",
        args: ["src/test.js"],
        scripts: {
            "src/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                try {
                    const root = await ctx.storage.getDirectory();
                    // Attempt to break out of StorageManager bounds
                    await root.getFileHandle("../../../../../../tmp/sandbox_escape.txt", { create: true });
                }
                catch (e: any) { console.error("BLOCKED:", e.message); throw e; }
            }
        },
        expectCode: 1,
        expectStderr: "BLOCKED:"
    },
    {
        name: "[StorageManager] Allows read/write within enclave (PWD)",
        args: ["test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
        files: { "data/.keep": "" },
        cwd: "data",
        scripts: {
            "data/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                const root = await ctx.storage.getDirectory();
                if (await ctx.storage.persisted() !== true) throw new Error("Expected PWD to be persisted");
                const fileHandle = await root.getFileHandle("test_write.txt", { create: true });
                const writable = await fileHandle.createWritable();
                const writer = writable.getWriter();
                await writer.write("hello");
                await writer.close();
                console.log("SUCCESS");
            }
        },
        expectCode: 0,
        expectStdout: "SUCCESS"
    },
    {
        name: "[Network] Blocks outgoing requests by default",
        args: ["src/test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
        scripts: {
            "src/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                try { await fetch("https://example.com"); }
                catch (e: any) { console.error("BLOCKED:", e.message); throw e; }
            }
        },
        expectCode: 1,
        expectStderr: "BLOCKED:"
    },
    {
        name: "[Network] Blocks SSRF to localhost even if network is open",
        args: ["src/test.js"],
        configs: { ".": { permissions: { network: ["example.com"], storage: { ".": { access: "read" } } } } },
        scripts: {
            "src/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                try { await fetch("http://127.0.0.1:8080"); }
                catch (e: any) { console.error("BLOCKED:", e.message); throw e; }
            }
        },
        expectCode: 1,
        expectStderr: "BLOCKED:"
    },
    {
        name: "[Environment] Scrubs injected host environment variables",
        args: ["src/test.js"],
        env: { "SUPER_SECRET_VAR": "pwned" },
        configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
        scripts: {
            "src/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                if (typeof Deno !== 'undefined') {
                    try {
                        const secret = Deno.env.get("SUPER_SECRET_VAR");
                        if (secret) { console.error("LEAKED:", secret); throw new Error("Leaked"); }
                        else { console.log("SECURE"); }
                    } catch (e: any) {
                        console.error("DENO_BLOCKED:", e.message);
                        throw e;
                    }
                } else {
                    console.error("DENO_BLOCKED: Runtime does not support Deno env mapping");
                    throw new Error("Blocked");
                }
            }
        },
        expectCode: 1,
        expectStderr: "DENO_BLOCKED: Runtime does not support Deno env mapping"
    },
    {
        name: "[Node/NPM] Sinkholes node:fs dynamic imports",
        args: ["src/test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
        scripts: {
            "src/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                try { await import("node:fs"); }
                catch (e: any) { console.error("BLOCKED:", e.message); throw e; }
            }
        },
        expectCode: 1,
        expectStderr: "Security Error: Node/NPM modules are blocked"
    },
    {
        name: "[StorageManager] Blocks writes conditionally via \"read\" access map limits",
        args: ["src/test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
        scripts: {
            "src/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                const root = await ctx.storage.getDirectory();
                try {
                    await root.getFileHandle("test.txt", { create: true });
                } catch (e: any) { console.error("BLOCKED:", e.message); throw e; }
            }
        },
        expectCode: 1,
        expectStderr: "BLOCKED:"
    },
    {
        name: "[Enclave / StorageManager] Obeys dynamic webrun.json filesystem scope limits per-execution",
        args: ["test_script.js"],
        configs: { ".": { permissions: { storage: { "my_custom_enclave": { access: "write" } } } } },
        files: {
            "my_custom_enclave/.keep": ""
        },
        cwd: "my_custom_enclave",
        scripts: {
            "my_custom_enclave/test_script.js": async (ctx: any) => {
                const { args, env } = ctx;
                const root = await ctx.storage.getDirectory();
                const fileHandle = await root.getFileHandle("test.txt", { create: true });
                const writable = await fileHandle.createWritable();
                const writer = writable.getWriter();
                await writer.write("enclave_write");
                await writer.close();
                console.log("ENCLAVE_SUCCESS");
            }
        },
        expectCode: 0,
        expectStdout: "ENCLAVE_SUCCESS"
    },
    {
        name: "[Network] Obeys dynamic webrun.json allowlists",
        args: ["src/test.js"],
        configs: { ".": { permissions: { network: ["example.com"], storage: { ".": { access: "read" } } } } },
        scripts: {
            "src/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                const resp = await fetch("https://example.com");
                if (resp.ok) {
                    console.log("FETCH_ALLOWED");
                } else {
                    console.error("FETCH_FAILED:", resp.status);
                    throw new Error("Fetch Failed");
                }
            }
        },
        expectCode: 0,
        expectStdout: "FETCH_ALLOWED"
    },
    {
        name: "[Execution] Receives explicit arguments, environment variables, and parsed flags via ctx object",
        configs: { ".": { permissions: { env: ["API_KEY"], storage: { ".": { access: "read" } } } } },
        env: { "API_KEY": "test_123" },
        args: ["src/test.js", "--mode", "debug", "--verbose=true", "-f", "--", "val1", "val2"],
        scripts: {
            "src/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                const pos = [...args];
                const apiKey = env.API_KEY;
                const mode = args.flags.mode;
                const verbose = args.flags.verbose;
                const f = args.flags.f;

                if (pos.join(",") === "val1,val2" && apiKey === "test_123" && mode === "debug" && String(verbose) === "true" && String(f) === "true") {
                    console.log("PARAMS_OK");
                } else {
                    console.error("FAILED params:", pos, apiKey, mode, verbose, f);
                    throw new Error("Params mismatch");
                }
            }
        },
        expectCode: 0,
        expectStdout: "PARAMS_OK"

    },
    {
        name: "[Execution] Protects positional array from flag manipulation natively",
        configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
        args: ["src/test.js", "----", "hacked", "positionalValue"],
        scripts: {
            "src/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                const pos = [...args];
                if (pos[0] !== "positionalValue") throw new Error("Positional array overwritten");
                if (args.flags[""] !== "hacked") throw new Error("Empty flag missing");
                console.log("REACHED");
            }
        },
        expectCode: 0
    },
    {
        name: "[StorageManager] Falls back to temporary dir if webrun.json is missing",
        args: ["src/test.js"],
        scripts: {
            "src/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                const root = await ctx.storage.getDirectory();
                if (await ctx.storage.persisted() !== false) throw new Error("Expected temp dir to not be persisted");
                const fh = await root.getFileHandle("temp.txt", { create: true });
                if (!fh) throw new Error("Could not create temp file");
                const w = await fh.createWritable();
                const writer = w.getWriter();
                await writer.write("ok");
                await writer.close();
                const r = await fh.getFile();
                const text = await r.text();
                if (text !== "ok") throw new Error("Could not read from temp");
            }
        },
        expectCode: 0
    },
    {
        name: "[StorageManager] Falls back to temporary dir if webrun.json has no storage allowlist",
        args: ["src/test.js"],
        configs: { ".": {} },
        files: {},
        scripts: {
            "src/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                const root = await ctx.storage.getDirectory();
                if (await ctx.storage.persisted() !== false) throw new Error("Expected temp dir to not be persisted");
                const fh = await root.getFileHandle("temp.txt", { create: true });
                if (!fh) throw new Error("Could not create temp file");
                const w = await fh.createWritable();
                const writer = w.getWriter();
                await writer.write("ok");
                await writer.close();
                const r = await fh.getFile();
                const text = await r.text();
                if (text !== "ok") throw new Error("Could not read from temp");
            }
        },
        expectCode: 0
    },
    {
        name: "[Configuration] Discovers and applies \"webrun\" key natively via package.json fallback schema",
        args: ["test_pkg.js"],
        files: { "package.json": JSON.stringify({ name: "pkg_test", webrun: { permissions: { storage: { "testing_dir": { access: "write" } } } } }), "testing_dir/.keep": "" },
        cwd: "testing_dir",
        scripts: {
            "testing_dir/test_pkg.js": async (ctx: any) => {
                const { args, env } = ctx;
                const root = await ctx.storage.getDirectory();
                const fh = await root.getFileHandle("test_write.txt", { create: true });
                const w = await fh.createWritable();
                await w.write("package_json_fallback_active");
                await w.close();
                console.log("PKG_JSON_FALLBACK_OK");
            }
        },
        expectCode: 0,
        expectStdout: "PKG_JSON_FALLBACK_OK"
    },
    {
        name: "[Environment] Injects host environment variables explicitly requested by string array",
        args: ["src/test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" } }, env: ["MY_HOST_VAR"] } } },
        env: { MY_HOST_VAR: "host_injected_value" },
        scripts: {
            "src/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                const val = env.MY_HOST_VAR;
                if (val !== "host_injected_value") {
                    console.error("FAILED match, got: " + val);
                    throw new Error("Missing or mapping mismatch: " + val);
                }
            }
        },
        expectCode: 0
    },
    {
        name: "[Execution] Aborts runaway processes via webrun.json configurable timeout",
        args: ["src/test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" } } }, limits: { timeoutMillis: 1000 } } },
        scripts: {
            "src/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                // Intentionally block the thread loop
                while (true) { }
            },
            // Deno's AbortSignal.timeout kill emits 143 (SIGTERM)
        },
        expectCode: 143
    },
    {
        name: "[StorageManager / Polyfill] Writable stream supports W3C positional writes and truncation",
        args: ["test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
        files: { "data/.keep": "" },
        cwd: "data",
        scripts: {
            "data/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                const root = await ctx.storage.getDirectory();
                const fh = await root.getFileHandle("positional.txt", { create: true });

                // 1. Write initial payload
                const w1 = await fh.createWritable();
                await w1.write("hello world");
                await w1.close();

                // 2. Overwrite middle bytes
                const w2 = await fh.createWritable({ keepExistingData: true });
                // Our polyfill opens with O_TRUNC always right now. We must simulate keepExistingData if we want true fidelity, but Deno open doesn't support keepExistingData in standard Web API. Wait, let's just write "hello world", seek back, and write "juno".

                const w3 = await fh.createWritable();
                await w3.write("hello world");
                await w3.write({ type: "write", position: 0, data: "juno " });
                await w3.close();

                const r = await fh.getFile();
                const text = await r.text();
                if (text !== "juno  world") throw new Error("Positional write failed: " + text);

                const w4 = await fh.createWritable();
                await w4.write("truncate_me_down");
                await w4.truncate(8);
                await w4.close();

                const r2 = await fh.getFile();
                const text2 = await r2.text();
                if (text2 !== "truncate") throw new Error("Truncate failed: " + text2);
            }
        },
        expectCode: 0
    },
    {
        name: "[StorageManager / Polyfill] File yields a standard ReadableStream for W3C memory-safe chunking",
        args: ["test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
        files: { "data/.keep": "" },
        cwd: "data",
        scripts: {
            "data/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                const root = await ctx.storage.getDirectory();
                const fh = await root.getFileHandle("stream.txt", { create: true });
                const w = await fh.createWritable();
                await w.write("streaming_data_test");
                await w.close();

                const file = await fh.getFile();
                if (!(file instanceof Blob)) throw new Error("getFile() must return a Blob subclass");
                if (file.size !== 19) throw new Error("File size metadata is incorrect");

                const stream = file.stream();
                const reader = stream.getReader();
                const { value, done } = await reader.read();

                if (done) throw new Error("Stream closed prematurely");
                const text = new TextDecoder().decode(value);
                if (text !== "streaming_data_test") throw new Error("Stream chunk data mismatch: " + text);
            }
        },
        expectCode: 0
    },
    {
        name: "[StorageManager / Polyfill] Evaluates strict W3C naming constraints locally to explicitly block path traversal injections",
        args: ["test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
        files: { "data/.keep": "" },
        cwd: "data",
        scripts: {
            "data/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                const root = await ctx.storage.getDirectory();
                try {
                    await root.getFileHandle("../../etc/passwd");
                } catch (e: any) {
                    if (e.name === "SecurityError") {
                        console.log("BLOCKED_TRAVERSAL");
                        return;
                    }
                    throw e;
                }
                throw new Error("Failed to block traversal");
            }
        },
        expectCode: 0,
        expectStdout: "BLOCKED_TRAVERSAL"
    },
    {
        name: "[StorageManager / Polyfill] Formally resolves recursive directory structures structurally using getDirectoryHandle",
        args: ["test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
        files: { "data/.keep": "" },
        cwd: "data",
        scripts: {
            "data/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                const root = await ctx.storage.getDirectory();
                const subDir = await root.getDirectoryHandle("nested_dir", { create: true });
                if (subDir.name !== "nested_dir" || subDir.kind !== "directory") throw new Error("Directory handle invalid");

                const file = await subDir.getFileHandle("deep_file.txt", { create: true });
                const writable = await file.createWritable();
                const writer = writable.getWriter();
                await writer.write("deep_data");
                await writer.close();

                const r = await file.getFile();
                const text = await r.text();
                if (text !== "deep_data") throw new Error("Deep file data mismatch");

                console.log("NESTED_SUCCESS");
            }
        },
        expectCode: 0,
        expectStdout: "NESTED_SUCCESS"
    },
    {
        name: "[StorageManager / Polyfill] Gracefully tears down local artifacts via removeEntry bindings dynamically",
        args: ["test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
        files: { "data/.keep": "" },
        cwd: "data",
        scripts: {
            "data/test.js": async (ctx: any) => {
                const { args, env } = ctx;
                const root = await ctx.storage.getDirectory();

                await root.getFileHandle("to_delete.txt", { create: true });
                await root.removeEntry("to_delete.txt");

                try {
                    await root.getFileHandle("to_delete.txt", { create: false });
                } catch (e: any) {
                    if (e.name === "NotFoundError") {
                        console.log("REMOVED_SUCCESS");
                        return;
                    }
                    throw e;
                }
                throw new Error("File was not removed");
            }
        },
        expectCode: 0,
        expectStdout: "REMOVED_SUCCESS"
    },
    {
        name: "[StorageManager / Polyfill] Preserves existing data when keepExistingData is true",
        args: ["test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
        files: { "data/.keep": "" },
        cwd: "data",
        scripts: {
            "data/test.js": async (ctx: any) => {
                const root = await ctx.storage.getDirectory();
                const fh = await root.getFileHandle("truncation_bug.txt", { create: true });

                // 1. Write the initial base data
                const w1 = await fh.createWritable();
                await w1.write("abcdef");
                await w1.close();

                // 2. Open the file AGAIN, explicitly requesting to keep existing data
                // W3C Standard: File remains "abcdef"
                // Current Webrun: file.createWritable() ignores the param and truncates the file to ""
                const w2 = await fh.createWritable({ keepExistingData: true });

                // 3. Overwrite just the first 3 bytes
                await w2.write({ type: "write", position: 0, data: "123" });
                await w2.close();

                // 4. Read the final result
                const r = await fh.getFile();
                const text = await r.text();

                // W3C Expected text: "123def"
                // Current Webrun text: "123" (because 'def' was truncated away)
                if (text !== "123def") {
                    throw new Error(`keepExistingData failed! Expected '123def', got '${text}'`);
                }

                console.log("SUCCESS");
            }
        },
        expectCode: 0,
        expectStdout: "SUCCESS"
    },
    {
        name: "[enclave / security] Blocks resolving malicious symlinks that point outside the enclave proactively",
        args: ["src/test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
        preflight: async (runDir: string) => {
            Deno.symlinkSync("/etc/passwd", join(runDir, "malicious_link"));
        },
        scripts: {
            "src/test.js": async (ctx: any) => {
                const root = await ctx.storage.getDirectory();
                try {
                    // If it resolves outside the enclave safely it throws SecurityError
                    const fh = await root.getFileHandle("malicious_link");
                    // If an attacker calls .getFile() directly on it
                    await fh.getFile();
                } catch (e: any) {
                    if (e.name === "SecurityError") {
                        console.log("SYMLINK_BLOCKED");
                        return;
                    }
                    throw e;
                }
                throw new Error("Symlink was not blocked");
            }
        },
        expectCode: 0,
        expectStdout: "SYMLINK_BLOCKED"
    },
    {
        name: "[StorageManager / Polyfill] Directory yields async iterator for keys/values/entries",
        args: ["test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
        files: { "data/.keep": "" },
        cwd: "data",
        scripts: {
            "data/test.js": async (ctx: any) => {
                const root = await ctx.storage.getDirectory();
                await root.getFileHandle("file_a.txt", { create: true });
                await root.getDirectoryHandle("dir_b", { create: true });

                const entries = [];
                for await (const [name, handle] of root.entries()) {
                    entries.push(`${name}:${handle.kind}`);
                }

                const keys = [];
                for await (const name of root.keys()) keys.push(name);

                const values = [];
                for await (const handle of root.values()) values.push(handle.kind);

                const defaultIter = [];
                for await (const [name, handle] of root) defaultIter.push(name);

                if (!entries.includes("file_a.txt:file") || !entries.includes("dir_b:directory")) throw new Error("entries() failed");
                if (!keys.includes("file_a.txt") || !keys.includes("dir_b")) throw new Error("keys() failed");
                if (!values.includes("file") || !values.includes("directory")) throw new Error("values() failed");
                if (!defaultIter.includes("file_a.txt") || !defaultIter.includes("dir_b")) throw new Error("[Symbol.asyncIterator]() failed");

                console.log("ITERATORS_OK");
            }
        },
        expectCode: 0,
        expectStdout: "ITERATORS_OK"
    },
    {
        name: "[StorageManager / Polyfill] Handles support isSameEntry and resolve",
        args: ["test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
        files: { "data/.keep": "" },
        cwd: "data",
        scripts: {
            "data/test.js": async (ctx: any) => {
                const root = await ctx.storage.getDirectory();
                const subDir = await root.getDirectoryHandle("nested_dir", { create: true });
                const fh1 = await subDir.getFileHandle("target.txt", { create: true });
                const fh2 = await subDir.getFileHandle("target.txt", { create: false });
                const subDir2 = await root.getDirectoryHandle("nested_dir", { create: false });

                if (!(await fh1.isSameEntry(fh2))) throw new Error("isSameEntry false negative for identical files");
                if (await fh1.isSameEntry(subDir)) throw new Error("isSameEntry false positive for different kinds");
                if (!(await subDir.isSameEntry(subDir2))) throw new Error("isSameEntry false negative for identical directories");

                const resolvePath = await root.resolve(fh1);
                if (!resolvePath || resolvePath.join("/") !== "nested_dir/target.txt") throw new Error("resolve() failed to build relative path");

                const outsideResolve = await subDir.resolve(root);
                if (outsideResolve !== null) throw new Error("resolve() should return null for non-descendants");

                console.log("HANDLES_OK");
            }
        },
        expectCode: 0,
        expectStdout: "HANDLES_OK"
    },
    {
        name: "[StorageManager / Polyfill] File arrayBuffer() resolves correctly",
        args: ["test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
        files: { "data/.keep": "" },
        cwd: "data",
        scripts: {
            "data/test.js": async (ctx: any) => {
                const root = await ctx.storage.getDirectory();
                const fh = await root.getFileHandle("binary.bin", { create: true });
                const w = await fh.createWritable();
                await w.write(new Uint8Array([0x01, 0x02, 0x03]));
                await w.close();

                const file = await fh.getFile();
                const buf = await file.arrayBuffer();
                const view = new Uint8Array(buf);

                if (view.length !== 3 || view[0] !== 1 || view[1] !== 2 || view[2] !== 3) {
                    throw new Error("arrayBuffer() corrupted data");
                }
                console.log("ARRAYBUFFER_OK");
            }
        },
        expectCode: 0,
        expectStdout: "ARRAYBUFFER_OK"
    },
    {
        name: "[StorageManager / Polyfill] removeEntry safely recurses on populated directories",
        args: ["test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
        files: { "data/.keep": "" },
        cwd: "data",
        scripts: {
            "data/test.js": async (ctx: any) => {
                const root = await ctx.storage.getDirectory();
                const populated = await root.getDirectoryHandle("populated", { create: true });
                const fh = await populated.getFileHandle("deep.txt", { create: true });
                const w = await fh.createWritable();
                await w.write("test");
                await w.close();

                await root.removeEntry("populated", { recursive: true });

                try {
                    await root.getDirectoryHandle("populated", { create: false });
                } catch (e: any) {
                    if (e.name === "NotFoundError") {
                        console.log("RECURSIVE_REMOVE_OK");
                        return;
                    }
                    throw e;
                }
                throw new Error("Populated directory not removed");
            }
        },
        expectCode: 0,
        expectStdout: "RECURSIVE_REMOVE_OK"
    },
    {
        name: "[Import Map] Valid Import Map Resolution",
        args: ["src/test.js"],
        configs: { ".": { importMap: "import_map.json", permissions: { storage: { ".": { access: "read" } } } } },
        files: {
            "import_map.json": JSON.stringify({ imports: { "@lib/": "./shared_lib/" } }),
            "shared_lib/math.ts": "export function add(a, b) { return a + b; }",
        },
        scripts: {
            "src/test.js": `
            import { add } from "@lib/math.ts";
            export default async function(ctx) {
                if (add(2, 3) !== 5) throw new Error("Math failed");
                console.log("IMPORT_SUCCESS");
            }
        `
        },
        expectCode: 0,
        expectStdout: "IMPORT_SUCCESS"
    },
    {
        name: "[Import Map] Sandbox I/O Integrity (The Breakout Attempt)",
        args: ["src/test.js"],
        configs: { ".": { importMap: "import_map.json", permissions: { storage: { ".": { access: "read" } } } } },
        files: {
            "import_map.json": JSON.stringify({ imports: { "@lib/": "./shared_lib/" } }),
            "shared_lib/math.ts": "export function add(a, b) { return a + b; }",
        },
        scripts: {
            "src/test.js": `
            import { add } from "@lib/math.ts";
            export default async function(ctx) {
                if (add(2, 3) !== 5) throw new Error("Math failed");
                
                const root = await ctx.storage.getDirectory();
                try {
                    await root.getFileHandle("shared_lib/math.ts");
                } catch (e) {
                    if (e.name === "SecurityError" || e.name === "NotFoundError" || e.name === "TypeError") { // Enclave blocks
                        console.error("BLOCKED:", e.message);
                        throw e;
                    }
                }
                throw new Error("Breakout succeeded");
            }
        `
        },
        expectCode: 1,
        expectStderr: "BLOCKED:"
    },
    {
        name: "[Security] Global Deno Namespace Destruction",
        args: ["src/test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
        scripts: {
            "src/test.js": `
            export default async function(ctx) {
                if (typeof Deno !== "undefined") {
                    console.error("BLOCKED: Deno namespace still exists!");
                    throw new Error("Deno namespace exists");
                }
                if (globalThis.Deno !== undefined) {
                    console.error("BLOCKED: globalThis.Deno still exists!");
                    throw new Error("globalThis.Deno exists");
                }
                console.log("DENO_DESTROYED");
            }
        `
        },
        expectCode: 0,
        expectStdout: "DENO_DESTROYED"
    },
    {
        name: "[Import Map] Node Sinkhole Preservation",
        args: ["src/test.js"],
        configs: { ".": { importMap: "import_map.json", permissions: { storage: { ".": { access: "read" } } } } },
        files: {
            "import_map.json": JSON.stringify({ imports: {} })
        },
        scripts: {
            "src/test.js": `
            import fs from "node:fs";
            export default async function(ctx) {
                console.log("WE SHOULD NOT REACH THIS");
            }
        `
        },
        expectCode: 1,
        expectStderr: "Node/NPM modules are blocked"
    },
    {
        name: "[Import Map] Proves importing from import map does not subvert user storage permissions",
        args: ["test.js"],
        configs: { ".": { importMap: "import_map.json", permissions: { storage: { "src": { access: "read" } } } } },
        files: {
            "import_map.json": JSON.stringify({ imports: { "@lib/": "./lib/" } }),
            "lib/math.ts": "export const MAGIC = 42;"
        },
        cwd: "src",
        scripts: {
            "src/test.js": `
            import { MAGIC } from "@lib/math.ts";
            export default async function(ctx) {
                console.log("SECRET_READ:", MAGIC);
            }
        `
        },
        expectCode: 1,
        expectStderr: "Requires read access to"
    },
    {
        name: "[OPFS / navigator.storage] Provides an isolated workspace accessible via getDirectory()",
        args: ["src/test.js"],
        configs: { ".": {} },
        scripts: {
            "src/test.js": async (ctx: any) => {
                const root = await navigator.storage.getDirectory();
                const fh = await root.getFileHandle("opfs_test.txt", { create: true });
                const w = await fh.createWritable();
                await w.write("opfs_isolated_data");
                await w.close();

                const r = await fh.getFile();
                const text = await r.text();

                if (text !== "opfs_isolated_data") throw new Error("OPFS read/write mismatch");

                const isPersisted = await navigator.storage.persisted();
                if (isPersisted !== false) throw new Error("OPFS should report as not persisted");

                console.log("OPFS_OK");
            }
        },
        expectCode: 0,
        expectStdout: "OPFS_OK"
    },
    {
        name: "[Security] Blocks env permission escalation",
        args: ["test.js"],
        configs: {
            ".": { permissions: { env: ["A"] } },
            "child": { permissions: { env: ["A", "B"] } }
        },
        files: {
            "child/test.js": "export default async function() { console.log('ESCAPED'); }",
        },
        cwd: "child",
        expectCode: 1,
        expectStderr: [
            "[Security Fatal] Privilege escalation detected in nested configuration.",
            "  Reason    : Escalating 'env' permissions",
            "  Attempted : B"
        ]
    },
    {
        name: "[Security] Blocks network permission escalation",
        args: ["test.js"],
        configs: {
            ".": { permissions: { network: ["a.com"] } },
            "child": { permissions: { network: ["b.com"] } }
        },
        files: {
            "child/test.js": "export default async function() { console.log('ESCAPED'); }",
        },
        cwd: "child",
        expectCode: 1,
        expectStderr: [
            "[Security Fatal] Privilege escalation detected in nested configuration.",
            "  Reason    : Escalating 'network' permissions",
            "  Attempted : b.com"
        ]
    },
    {
        name: "[Security] Blocks storage path escalation",
        args: ["test.js"],
        configs: {
            ".": { permissions: { storage: { "child": { access: "read" } } } },
            "child": { permissions: { storage: { "../sibling": { access: "read" } } } }
        },
        files: {
            "child/test.js": "export default async function() { console.log('ESCAPED'); }",
        },
        cwd: "child",
        expectCode: 1,
        expectStderr: [
            "[Security Fatal] Privilege escalation detected in nested configuration.",
            "  Reason    : Escalating 'storage' permissions"
        ]
    },
    {
        name: "[Security] Blocks storage write escalation over read parent",
        args: ["test.js"],
        configs: {
            ".": { permissions: { storage: { "child": { access: "read" } } } },
            "child": { permissions: { storage: { ".": { access: "write" } } } }
        },
        files: {
            "child/test.js": "export default async function() { console.log('ESCAPED'); }",
        },
        cwd: "child",
        expectCode: 1,
        expectStderr: [
            "[Security Fatal] Privilege escalation detected in nested configuration.",
            "  Reason    : Escalating 'storage' permissions"
        ]
    },
    {
        name: "[Security] Blocks timeoutMillis limit escalation",
        args: ["test.js"],
        configs: {
            ".": { limits: { timeoutMillis: 500 } },
            "child": { limits: { timeoutMillis: 1000 } }
        },
        files: {
            "child/test.js": "export default async function() { console.log('ESCAPED'); }",
        },
        cwd: "child",
        expectCode: 1,
        expectStderr: [
            "[Security Fatal] Privilege escalation detected in nested configuration.",
            "  Reason    : Escalating 'timeoutMillis' limit",
            "  Attempted : 1000",
            "  Permitted : 500"
        ]
    },
    {
        name: "[Security] Blocks memoryMB limit escalation",
        args: ["test.js"],
        configs: {
            ".": { limits: { memoryMB: 128 } },
            "child": { limits: { memoryMB: 256 } }
        },
        files: {
            "child/test.js": "export default async function() { console.log('ESCAPED'); }",
        },
        cwd: "child",
        expectCode: 1,
        expectStderr: [
            "[Security Fatal] Privilege escalation detected in nested configuration.",
            "  Reason    : Escalating 'memoryMB' limit",
            "  Attempted : 256",
            "  Permitted : 128"
        ]
    },
    {
        name: "[Security] Permits valid narrowing of parent timeoutMillis limit",
        args: ["test.js"],
        configs: {
            ".": { limits: { timeoutMillis: 5000 } },
            "child": { limits: { timeoutMillis: 100 } }
        },
        cwd: "child",
        scripts: {
            "child/test.js": `
            export default async function(ctx) {
                // Spin forever to trigger the 100ms timeout
                while(true) {}
            }
        `
        },
        expectCode: 143
    },
    {
        name: "[Security] Permits valid narrowing of parent memoryMB limit",
        args: ["test.js"],
        configs: {
            ".": { limits: { memoryMB: 1024 } },
            "child": { limits: { memoryMB: 128 } }
        },
        cwd: "child",
        scripts: {
            "child/test.js": `
            export default async function(ctx) {
                const a = [];
                // Consume memory asynchronously so the RSS scanner interval can tick
                return new Promise((resolve) => {
                    setInterval(() => {
                        for(let i=0; i<100; i++) {
                            // Allocate ~100MB total per tick
                            a.push(new Uint8Array(1024 * 1024));
                        }
                    }, 50);
                });
            }
        `
        },
        expectCode: 137,
        expectStderr: [
            "[Fatal] Memory limit exceeded!",
            "  Current:"
        ]
    },
    {
        name: "[Security] Permits valid narrowing of parent configuration and strictly enforces it",
        args: ["test.js"],
        configs: {
            ".": {
                permissions: {
                    env: ["A", "B"],
                    network: ["a.com", "b.com"],
                    storage: { ".": { access: "write" } }
                },
                limits: { timeoutMillis: 10000, memoryMB: 512 }
            },
            "child": {
                permissions: {
                    env: ["A"],
                    network: ["a.com"],
                    storage: {
                        ".": { access: "read" },
                        "narrow_dir": { access: "write" }
                    }
                },
                limits: { timeoutMillis: 5000, memoryMB: 256 }
            }
        },
        files: {
            "child/narrow_dir/.keep": ""
        },
        scripts: {
            "child/test.js": `
            export default async function(ctx) {
                const { env, storage } = ctx;
                
                if (env.B !== undefined) throw new Error("Env B leaked");
                if (env.A !== "secret") throw new Error("Env A missing");
                
                const root = await storage.getDirectory();
                
                // 1. Should fail to write to PWD (since narrowed to read-only)
                let blocked = false;
                try {
                    const file = await root.getFileHandle("test_write.txt", { create: true });
                    const w = await file.createWritable();
                    await w.close();
                } catch (e) {
                    blocked = true; // Deno PermissionDenied
                }
                if (!blocked) throw new Error("Successfully wrote to read-only PWD");
                
                // 2. Should succeed writing to narrow_dir (granted write access)
                const narrow = await root.getDirectoryHandle("narrow_dir");
                const file = await narrow.getFileHandle("ok.txt", { create: true });
                const w = await file.createWritable();
                await w.write("val");
                await w.close();
                
                console.log("NARROW_SUCCESS");
            }
        `
        },
        env: { "A": "secret", "B": "leaked" },
        cwd: "child",
        expectCode: 0,
        expectStdout: "NARROW_SUCCESS"
    },
    {
        name: "[Security] Aborts if policy allows writing to the webrun executable directory",
        args: ["src/test.js"],
        preflight: async (runDir: string, tc: any) => {
            const join = (await import("https://deno.land/std@0.224.0/path/mod.ts")).join;
            const workerBin = tc.WORKER_BIN;
            const binDir = workerBin.substring(0, workerBin.lastIndexOf("/")) || "/";
            const cfg = { permissions: { storage: { [binDir]: { access: "write" } } } };
            Deno.writeTextFileSync(join(runDir, "webrun.json"), JSON.stringify(cfg));
        },
        scripts: {
            "src/test.js": `
            export default async function(ctx) {
                console.log("ESCAPED");
            }
        `
        },
        expectCode: 1,
        expectStderr: [
            "[Security Fatal] The webrun file is within a permitted write directory. Refusing to run.",
            "  Executable:"
        ]
    },
    {
        name: "[Security] Aborts if policy allows writing to the top-level webrun.json directory",
        args: ["src/test.js"],
        configs: { ".": { permissions: { storage: { ".": { access: "write" } } } } },
        scripts: {
            "src/test.js": `
            export default async function(ctx) {
                console.log("ESCAPED");
            }
        `
        },
        expectCode: 1,
        expectStderr: [
            "[Security Fatal] The webrun file is within a permitted write directory. Refusing to run.",
            "  Executable:"
        ]
    },
    {
        name: "[Security] Aborts if policy allows writing to a child webrun.json directory",
        args: ["test.js"],
        configs: {
            ".": { permissions: { storage: { "child": { access: "write" } } } },
            "child": { permissions: { storage: { ".": { access: "write" } } } }
        },
        files: {
            "child/test.js": "export default async function(ctx) { console.log('ESCAPED'); }"
        },
        cwd: "child",
        expectCode: 1,
        expectStderr: [
            "[Security Fatal] The webrun file is within a permitted write directory. Refusing to run.",
            "  Executable:"
        ]
    },
    {
        name: "[CLI] Prints help screen when --help is passed",
        args: ["src/test.js", "--help"],
        scripts: {
            "src/test.js": `export default async function() {}`
        },
        expectCode: 0,
    },
    {
        name: "[CLI] Prints version when --version is passed",
        args: ["src/test.js", "--version"],
        scripts: {
            "src/test.js": `export default async function() {}`
        },
        expectCode: 0,
        expectStdout: "webrun dev"
    },
    {
        name: "[Security] Blocks import maps within a writable directory proactively",
        args: ["src/test.js"],
        configs: { ".": { importMap: "my_import_map.json", permissions: { storage: { ".": { access: "write" } } } } },
        files: {
            "my_import_map.json": JSON.stringify({})
        },
        scripts: {
            "src/test.js": async () => { }
        },
        expectCode: 1,
        expectStderr: [
            "[Security Fatal] The webrun file is within a permitted write directory. Refusing to run.",
            "  Executable:"
        ]
    },
    {
        name: "[Import Map] Merges parent and child import maps with child precedence",
        args: ["test.js"],
        configs: {
            ".": { importMap: "parent_map.json", permissions: { storage: { ".": { access: "read" } } } },
            "child": { importMap: "child_map.json" }
        },
        files: {
            "parent_map.json": JSON.stringify({ imports: { "parent-mod": "data:text/javascript,export const p = 1;", "shared": "data:text/javascript,export const s = 1;" } }),
            "child/child_map.json": JSON.stringify({ imports: { "child-mod": "data:text/javascript,export const c = 2;", "shared": "data:text/javascript,export const s = 2;" } }),
        },
        cwd: "child",
        scripts: {
            "child/test.js": `
            import { p } from "parent-mod";
            import { c } from "child-mod";
            import { s } from "shared";
            export default function() {
                if (p !== 1) throw new Error("Parent missing");
                if (c !== 2) throw new Error("Child missing");
                if (s !== 2) throw new Error("Child did not override parent shared");
                console.log("MERGED_OK");
            }
        `
        },
        expectCode: 0,
        expectStdout: "MERGED_OK"
    },
    {
        name: "[Import Map] Resolves relative scope keys safely against their declaring map directory",
        args: ["test.js"],
        configs: {
            ".": { importMap: "parent_map.json", permissions: { storage: { ".": { access: "read" } } } },
            "child": { importMap: "child_map.json", permissions: { storage: { ".": { access: "read" }, "../parent-scope": { access: "read" } } } }
        },
        files: {
            "parent_map.json": JSON.stringify({
                scopes: {
                    "./parent-scope/": {
                        "utils_mod": "data:text/javascript,export const a = 'parent-a';"
                    }
                }
            }),
            "parent-scope/app.ts": `
                import { a } from "utils_mod";
                export const pApp = a;
            `,
            "child/child_map.json": JSON.stringify({
                scopes: {
                    "./child-scope/": {
                        "utils_mod": "data:text/javascript,export const a = 'child-a';"
                    }
                }
            }),
            "child/child-scope/app.ts": `
                import { a } from "utils_mod";
                export const cApp = a;
            `,
        },
        cwd: "child",
        scripts: {
            "child/test.js": `
            import { pApp } from "../parent-scope/app.ts";
            import { cApp } from "./child-scope/app.ts";
            export default function() {
                if (pApp !== 'parent-a') throw new Error("Parent scope failed: " + pApp);
                if (cApp !== 'child-a') throw new Error("Child scope failed: " + cApp);
                console.log("SCOPES_OK");
            }
        `
        },
        expectCode: 0,
        expectStdout: "SCOPES_OK"
    },
    {
        name: "[CLI] --test accepts multiple test files and runs them all natively",
        args: ["--test", "suite_a.test.ts", "suite_b.test.ts"],
        files: {
            "suite_a.test.ts": "export function testOne(t: any) { t.log('RUNNING SUITE A'); }",
            "suite_b.test.ts": "export function testTwo(t: any) { t.log('RUNNING SUITE B'); }"
        },
        expectCode: 0,
        expectStdout: "RUNNING SUITE A",
        expectStderr: ""
    }
    ];

    for (const t of tests) {
        await tc.run(t.name, async () => {
            const runDir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: "sandbox_tb_" }));

            const tree: Record<string, string> = { ...(t.files || {}) };

            if (t.configs) {
                for (const [dir, config] of Object.entries(t.configs)) {
                    tree[join(dir, "webrun.json")] = typeof config === "string" ? config : JSON.stringify(config);
                }
            }

            if (t.scripts) {
                for (const [filename, content] of Object.entries(t.scripts)) {
                    tree[filename] = typeof content === "function" ?
                        `export default async function(ctx) { await (${content.toString()})(ctx); }` :
                        content;
                }
            }

            for (const [relPath, content] of Object.entries(tree)) {
                const absPath = join(runDir, relPath);
                Deno.mkdirSync(dirname(absPath), { recursive: true });
                Deno.writeTextFileSync(absPath, content);
            }

            Deno.mkdirSync(join(runDir, "src"), { recursive: true });

            if (t.preflight) {
                await t.preflight(runDir, tc);
            }
            const testCwd = t.cwd ? join(runDir, t.cwd) : runDir;
            const cmd = new Deno.Command(WORKER_BIN, {
                args: t.args || [],
                cwd: testCwd,
                env: t.env,
                stdout: "piped",
                stderr: "piped"
            });

            const output = await cmd.output();
            const stdout = new TextDecoder().decode(output.stdout);
            const stderr = new TextDecoder().decode(output.stderr);

            // Clean up ephemeral logic
            try { Deno.removeSync(runDir, { recursive: true }); } catch (_) { }

            if (t.expectCode === "nonzero") {
                if (output.code === 0) {
                    console.error(`[${t.name}] FAILED. Expected non-zero code, got 0`);
                    console.error("STDOUT:", stdout);
                    console.error("STDERR:", stderr);
                    throw new Error("Expected non-zero exit code");
                }
            } else {
                if (output.code !== t.expectCode) {
                    console.error(`[${t.name}] FAILED. Expected code ${t.expectCode}, got ${output.code}`);
                    console.error("STDOUT:", stdout);
                    console.error("STDERR:", stderr);
                }
                assertEquals(output.code, t.expectCode);
            }

            const combinedOutput = stdout + "\n" + stderr;

            if (t.expectStdout) {
                const exps = Array.isArray(t.expectStdout) ? t.expectStdout : [t.expectStdout];
                for (const exp of exps) {
                    assertStringIncludes(combinedOutput, exp);
                }
            }
            if (t.expectStderr) {
                const exps = Array.isArray(t.expectStderr) ? t.expectStderr : [t.expectStderr];
                for (const exp of exps) {
                    assertStringIncludes(combinedOutput, exp);
                }
            }
        });
    }
}

export async function testBundlingStructuralIntegrity(tc: any) {
    const Deno = tc.Deno;
    const WORKER_BIN = tc.WORKER_BIN;
    const join = (await import("https://deno.land/std@0.224.0/path/mod.ts")).join;
    const dirname = (await import("https://deno.land/std@0.224.0/path/mod.ts")).dirname;
    const assertEquals = (await import("https://deno.land/std@0.224.0/assert/mod.ts")).assertEquals;

    if (tc.IS_REPACKED_TEST) return;

    await tc.run("[CLI] Bundling and Unbundling maintains structural integrity", async () => {
        const runDir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: "sandbox_tb_" }));

    const isBundled = Deno.readTextFileSync(WORKER_BIN).includes("\n__DATA__\n");
        let bundledExecutable = WORKER_BIN;

        if (!isBundled) {
            const workspaceDir = dirname(WORKER_BIN);
            const bundle1Cmd = new Deno.Command(WORKER_BIN, {
                args: ["--self-bundle"],
                cwd: workspaceDir,
                stdout: "piped"
            });
            const bundle1Output = await bundle1Cmd.output();
            assertEquals(bundle1Output.code, 0);
            Deno.writeFileSync(join(runDir, "first_bundle"), bundle1Output.stdout);
            Deno.chmodSync(join(runDir, "first_bundle"), 0o755);
            bundledExecutable = join(runDir, "first_bundle");
        }

        const unbundleCmd = new Deno.Command(bundledExecutable, {
            args: ["--self-unbundle", join(runDir, "src_out")],
        });
        const unbundleOutput = await unbundleCmd.output();
        assertEquals(unbundleOutput.code, 0);

        const bundle2Cmd = new Deno.Command(join(runDir, "src_out", "webrun"), {
            args: ["--self-bundle"],
            cwd: join(runDir, "src_out"),
            stdout: "piped"
        });
        const bundleOutput = await bundle2Cmd.output();
        assertEquals(bundleOutput.code, 0);
        Deno.writeFileSync(join(runDir, "webrun-repacked"), bundleOutput.stdout);
        Deno.chmodSync(join(runDir, "webrun-repacked"), 0o755);

        const evalCmd = new Deno.Command(join(runDir, "webrun-repacked"), {
            args: ["--self-test"],
            env: {
                "WEBRUN_IS_REPACKED_TEST": "1",
                "WEBRUN_DENO_DIR": dirname(Deno.execPath())
            }
        });
        const evalOutput = await evalCmd.output();
        if (evalOutput.code !== 0) {
            console.error(new TextDecoder().decode(evalOutput.stderr));
            console.error(new TextDecoder().decode(evalOutput.stdout));
        }
        assertEquals(evalOutput.code, 0);

        try { Deno.removeSync(runDir, { recursive: true }); } catch (_) { }
    });
}
