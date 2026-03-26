import { runTests } from "./framework.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

export async function testFileSystemCompatibility(t: any) {
    await runTests(t, [
        {
            name: "Writable stream supports W3C positional writes and truncation",
            args: ["test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
            files: { "data/.keep": "" },
            cwd: "data",
            scripts: {
                "data/test.js": async (ctx: any) => {
                    const { args, env } = ctx;
                    const root = ctx.dir;
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
            name: "File yields a standard ReadableStream for W3C memory-safe chunking",
            args: ["test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
            files: { "data/.keep": "" },
            cwd: "data",
            scripts: {
                "data/test.js": async (ctx: any) => {
                    const { args, env } = ctx;
                    const root = ctx.dir;
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
            name: "Evaluates strict W3C naming constraints locally to explicitly block path traversal injections",
            args: ["test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
            files: { "data/.keep": "" },
            cwd: "data",
            scripts: {
                "data/test.js": async (ctx: any) => {
                    const { args, env } = ctx;
                    const root = ctx.dir;
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
            name: "Formally resolves recursive directory structures structurally using getDirectoryHandle",
            args: ["test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
            files: { "data/.keep": "" },
            cwd: "data",
            scripts: {
                "data/test.js": async (ctx: any) => {
                    const { args, env } = ctx;
                    const root = ctx.dir;
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
            name: "Gracefully tears down local artifacts via removeEntry bindings dynamically",
            args: ["test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
            files: { "data/.keep": "" },
            cwd: "data",
            scripts: {
                "data/test.js": async (ctx: any) => {
                    const { args, env } = ctx;
                    const root = ctx.dir;

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
            name: "Preserves existing data when keepExistingData is true",
            args: ["test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
            files: { "data/.keep": "" },
            cwd: "data",
            scripts: {
                "data/test.js": async (ctx: any) => {
                    const root = ctx.dir;
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
            name: "Blocks resolving malicious symlinks that point outside the enclave proactively",
            args: ["src/test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
            preflight: async (runDir: string, t: any) => {
                t.Deno.symlinkSync("/etc/passwd", join(runDir, "malicious_link"));
            },
            scripts: {
                "src/test.js": async (ctx: any) => {
                    const root = ctx.dir;
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
            name: "Directory yields async iterator for keys/values/entries",
            args: ["test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
            files: { "data/.keep": "" },
            cwd: "data",
            scripts: {
                "data/test.js": async (ctx: any) => {
                    const root = ctx.dir;
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
            name: "Handles support isSameEntry and resolve",
            args: ["test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
            files: { "data/.keep": "" },
            cwd: "data",
            scripts: {
                "data/test.js": async (ctx: any) => {
                    const root = ctx.dir;
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
            name: "File arrayBuffer() resolves correctly",
            args: ["test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
            files: { "data/.keep": "" },
            cwd: "data",
            scripts: {
                "data/test.js": async (ctx: any) => {
                    const root = ctx.dir;
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
            name: "removeEntry safely recurses on populated directories",
            args: ["test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
            files: { "data/.keep": "" },
            cwd: "data",
            scripts: {
                "data/test.js": async (ctx: any) => {
                    const root = ctx.dir;
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
        }]);
}

