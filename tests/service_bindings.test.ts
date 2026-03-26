import { runTests } from "./framework.ts";

export async function testServiceBindings(t: any) {
    await runTests(t, [
        {
            name: "UUID Injection Context: Injects capabilities into ctx.bindings mapped to unforgeable schemas",
            args: ["test.js"],
            configs: { ".": { bindings: { "test_svc": { module: "worker.js" } } } },
            files: {
                "worker.js": `export default { fetch() { return new Response("ok"); } }`
            },
            scripts: {
                "test.js": `
                    export default async function(ctx) {
                        if (!ctx.bindings.test_svc) throw new Error("Binding not injected");
                        if (!ctx.bindings.test_svc.startsWith("webrun://")) throw new Error("URI schema is not webrun://");
                        if (ctx.bindings.test_svc.includes("worker.js")) throw new Error("URI leaks physical path");
                        console.log("UUID_INJECTION_OK");
                    }
                `
            },
            expectCode: 0,
            expectStdout: "UUID_INJECTION_OK"
        },
        {
            name: "Module Fetch Routing: Proxies raw Web API fetch to module Service Worker via postMessage IPC",
            args: ["test.js"],
            configs: { ".": { bindings: { "ai": { module: "llm.js" } } } },
            files: {
                "llm.js": `
                    export default { 
                        async fetch(req) { 
                            const text = await req.text();
                            if (text === "hello") {
                                return new Response("world_from_worker", { headers: { "X-Custom": "Foo" } });
                            }
                            return new Response("bad");
                        } 
                    }
                `
            },
            scripts: {
                "test.js": `
                    export default async function(ctx) {
                        const res = await fetch(ctx.bindings.ai, { method: "POST", body: "hello" });
                        if (res.status !== 200) throw new Error("Failed proxy fetch");
                        const text = await res.text();
                        if (text !== "world_from_worker") throw new Error("IPC payload body mismatch: " + text);
                        if (res.headers.get("x-custom") !== "Foo") throw new Error("IPC payload headers mismatch");
                        console.log("FETCH_PROXY_OK");
                    }
                `
            },
            expectCode: 0,
            expectStdout: "FETCH_PROXY_OK"
        },
        {
            name: "UUID Forgery & Null Routing: Explicitly rejects standard fetch calls aiming directly at native ports or unlisted UUIDs",
            args: ["test.js"],
            scripts: {
                "test.js": `
                    export default async function(ctx) {
                        let blocked = false;
                        try {
                            await fetch("webrun://arbitrary_uuid_1234/api");
                        } catch (e) {
                            if (e.message.includes("Unauthorized binding UUID") || e.message.includes("Failed to fetch")) {
                                blocked = true;
                            }
                        }
                        if (!blocked) throw new Error("Sandbox failed to block forged UUID schema fetch");
                        
                        blocked = false;
                        try {
                            await fetch("http://127.0.0.1:49152/api");
                        } catch(e) {
                            if (e.message.includes("SSRF Blocked by Sandbox")) blocked = true;
                        }
                        if (!blocked) throw new Error("Sandbox failed to block application-layer localhost proxy fetching");
                        
                        console.log("FORGERY_BLOCK_OK");
                    }
                `
            },
            expectCode: 0,
            expectStdout: "FORGERY_BLOCK_OK"
        },
        // {
        //     name: "Isolated Memory Pooling: Overallocating Service Workers cascade abort to sandbox runtime",
        //     args: ["test.js"],
        //     configs: { ".": { bindings: { "memhog": { module: "hog.js" } }, limits: { memoryMB: 128 } } },
        //     files: {
        //         "hog.js": `
        //             export default {
        //                 async fetch() {
        //                     const arr = [];
        //                     while(true) {
        //                         arr.push(new Uint8Array(1024 * 1024 * 100)); // Requesting 10MB chunks
        //                         await new Promise(r => setTimeout(r, 50));
        //                     }
        //                 }
        //             }
        //         `
        //     },
        //     scripts: {
        //         "test.js": `
        //             export default async function(ctx) {
        //                 try {
        //                     await fetch(ctx.bindings.memhog);
        //                 } catch (e) {}
        //                 await new Promise(() => {}); // yield to event loop indefinitely
        //             }
        //         `
        //     },
        //     expectCode: 137, // OOM kill
        //     expectStderr: [
        //         "[Fatal] Memory limit exceeded!",
        //         "  Current:"
        //     ]
        // },
        {
            name: "Service Crash Propagation: Module unhandled exceptions return native 500 status over IPC proxy",
            args: ["test.js"],
            configs: { ".": { bindings: { "crash": { module: "crash.js" } } } },
            files: {
                "crash.js": `
                    export default {
                        async fetch(req) {
                            throw new Error("Simulated unhandled worker exception");
                        }
                    }
                `
            },
            scripts: {
                "test.js": `
                    export default async function(ctx) {
                        const res = await fetch(ctx.bindings.crash);
                        if (res.status !== 500) throw new Error("Worker crash did not translate to HTTP 500");
                        
                        const text = await res.text();
                        if (!text.includes("Simulated unhandled worker exception")) throw new Error("Error missing: " + text);
                        
                        console.log("CRASH_PROPAGATION_OK");
                    }
                `
            },
            expectCode: 0,
            expectStdout: "CRASH_PROPAGATION_OK"
        }
    ]);
}

