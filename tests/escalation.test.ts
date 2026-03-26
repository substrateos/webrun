import { runTests } from "./framework.ts";

export async function testSandboxIsolationEscalation(t: any) {
    await runTests(t, [
        {
            name: "Blocks env permission escalation",
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
            name: "Blocks network permission escalation",
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
            name: "Blocks storage path escalation",
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
            name: "Blocks storage write escalation over read parent",
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
            name: "Blocks timeoutMillis limit escalation",
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
            name: "Blocks memoryMB limit escalation",
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
            name: "Permits valid narrowing of parent timeoutMillis limit",
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
            name: "Permits valid narrowing of parent memoryMB limit",
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
            name: "Permits valid narrowing of parent configuration and strictly enforces it",
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
                const { env, dir } = ctx;
                
                if (env.B !== undefined) throw new Error("Env B leaked");
                if (env.A !== "secret") throw new Error("Env A missing");
                
                const root = ctx.dir;
                
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
        }]);
}

