import { runTests } from "./framework.ts";

export async function testSandboxIsolation(t: any) {
    await runTests(t, [
        {
            name: "Blocks read outside enclave (/etc/passwd)",
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
            name: "Blocks write outside enclave (/tmp/escape)",
            args: ["src/test.js"],
            scripts: {
                "src/test.js": async (ctx: any) => {
                    const { args, env } = ctx;
                    try {
                        const root = ctx.dir;
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
            name: "Allows read/write within enclave (PWD)",
            args: ["test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" }, "data": { access: "write" } } } } },
            files: { "data/.keep": "" },
            cwd: "data",
            scripts: {
                "data/test.js": async (ctx: any) => {
                    const { args, env } = ctx;
                    const root = ctx.dir;
                    if (ctx.persisted !== true) throw new Error("Expected PWD to be persisted");
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
            name: "Blocks outgoing requests by default",
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
            name: "Blocks SSRF to localhost even if network is open",
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
            name: "Scrubs injected host environment variables",
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
            name: "Sinkholes node:fs dynamic imports",
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
            name: "Blocks writes conditionally via \"read\" access map limits",
            args: ["src/test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
            scripts: {
                "src/test.js": async (ctx: any) => {
                    const { args, env } = ctx;
                    const root = ctx.dir;
                    try {
                        await root.getFileHandle("test.txt", { create: true });
                    } catch (e: any) { console.error("BLOCKED:", e.message); throw e; }
                }
            },
            expectCode: 1,
            expectStderr: "BLOCKED:"
        }])
}

