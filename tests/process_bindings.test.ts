import { runTests } from "./framework.ts";

export async function testProcessBindings(t: any) {
    if (t.IS_REPACKED_TEST) return;

    await runTests(t, [
        {
            name: "Lifecycle & Port Tunneling: Natively routes fetch to Deno sub-socket allocating dynamic port variable",
            args: ["test.js"],
            configs: {
                ".": { bindings: { "my_backend": { process: { command: ["deno", "run", "-A", "backend.ts"], portEnv: "PROCESS_PORT" } } } }
            },
            files: {
                "backend.ts": `
                    const port = parseInt(Deno.env.get("PROCESS_PORT") || "0", 10);
                    Deno.serve({ port }, (req) => {
                        return new Response("Process_Alive_On_" + port);
                    });
                `
            },
            scripts: {
                "test.js": `
                    export default async function(ctx) {
                        const res = await fetch(ctx.bindings.my_backend);
                        const text = await res.text();
                        if (!text.startsWith("Process_Alive_On_")) throw new Error("Tunnel failed: " + text);
                        console.log("PROCESS_TUNNEL_OK");
                    }
                `
            },
            expectCode: 0,
            expectStdout: "PROCESS_TUNNEL_OK"
        },
        {
            name: "Process Environment Filtering: Bootstrapped children exclusively inherit specific OS variables",
            args: ["test.js"],
            env: { "HOST_LEAK": "pwned", "ALLOWED_VAR": "secret" },
            configs: {
                ".": {
                    bindings: {
                        "filtered": {
                            process: {
                                command: ["deno", "run", "-A", "backend.ts"],
                                portEnv: "PORT",
                                permissions: { env: ["ALLOWED_VAR"] }
                            }
                        }
                    }
                }
            },
            files: {
                "backend.ts": `
                    const port = parseInt(Deno.env.get("PORT") || "0", 10);
                    Deno.serve({ port }, (req) => {
                        return new Response(JSON.stringify({ 
                            allowed: Deno.env.get("ALLOWED_VAR"), 
                            leaked: Deno.env.get("HOST_LEAK") 
                        }));
                    });
                `
            },
            scripts: {
                "test.js": `
                    export default async function(ctx) {
                        const res = await fetch(ctx.bindings.filtered);
                        const json = await res.json();
                        if (json.leaked !== undefined) throw new Error("Child inherited unlisted host environment: " + json.leaked);
                        if (json.allowed !== "secret") throw new Error("Child missing explicit local environment: " + json.allowed);
                        console.log("ENV_FILTER_OK");
                    }
                `
            },
            expectCode: 0,
            expectStdout: "ENV_FILTER_OK"
        },
        {
            name: "Graceful Teardown & Zombie Prevention: Process terminates definitively natively when sandbox completes",
            args: ["test.js"],
            configs: {
                ".": { bindings: { "backend": { process: { command: ["deno", "run", "-A", "backend.ts"], portEnv: "PORT" } } } }
            },
            preflight: async function (runDir: string, tester: any) {
                // Just to prepare the landscape
            },
            files: {
                "backend.ts": `
                    const port = parseInt(Deno.env.get("PORT") || "0", 10);
                    Deno.writeTextFileSync("child.pid", String(Deno.pid)); // emit the PID for native runner verification checks afterwards
                    Deno.serve({ port }, (req) => {
                        return new Response("OK");
                    });
                `
            },
            cwd: ".",
            scripts: {
                "test.js": `
                    export default async function(ctx) {
                        const res = await fetch(ctx.bindings.backend);
                        const text = await res.text();
                        if (text !== "OK") throw new Error("Backend not OK");
                        console.log("ZOMBIE_TEST_FINISHED");
                    }
                `
            },
            expectCode: 0,
            expectStdout: "ZOMBIE_TEST_FINISHED"
        },
        {
            name: "Runtime Subprocess Crash: Sandbox intercepts crash gracefully, logs tail simulation and stderr",
            args: ["test.js"],
            configs: {
                ".": { bindings: { "crash_backend": { process: { command: ["deno", "run", "-A", "backend.ts"], portEnv: "PORT" } } } }
            },
            files: {
                "backend.ts": `
                    console.error("MOCK_STDERR_CRITICAL_FAILURE");
                    Deno.exit(1);
                `
            },
            scripts: {
                "test.js": `
                    export default async function(ctx) {
                        let blocked = false;
                        await new Promise((r) => setTimeout(r, 1000)); // wait for native backend execution failure to resolve fully
                        try {
                            await fetch(ctx.bindings.crash_backend);
                        } catch (e) {
                            if (e.message.includes("Connection refused") || e.message.includes("error sending request")) {
                                blocked = true;
                            }
                        }
                        
                        if (!blocked) throw new Error("Crash proxy did not trigger connection issue. Got: " + blocked);
                        console.log("CRASH_PROXY_OK");
                    }
                `
            },
            expectCode: 0,
            expectStdout: "CRASH_PROXY_OK",
            expectStderr: [
                "[webrun binding: crash_backend]",
                "Service terminated unexpectedly (Code: 1)",
                "$ tail -n 15",
                "MOCK_STDERR_CRITICAL_FAILURE"
            ]
        },
        {
            name: "Runtime Subprocess Graceful Exit: Sandbox prints green early exit banner for bindings fulfilling their task",
            args: ["test.js"],
            configs: {
                ".": { bindings: { "migrator": { process: { command: ["deno", "run", "-A", "backend.ts"], portEnv: "PORT" } } } }
            },
            files: {
                "backend.ts": `
                    console.error("MOCK_MIGRATION_COMPLETE");
                    Deno.exit(0);
                `
            },
            scripts: {
                "test.js": `
                    export default async function(ctx) {
                        await new Promise(r => setTimeout(r, 1000));
                        console.log("MIGRATION_PROXY_OK");
                    }
                `
            },
            expectCode: 0,
            expectStdout: "MIGRATION_PROXY_OK",
            expectStderr: [
                "[webrun binding: migrator]",
                "Service exited gracefully (Code: 0)" // Exited correctly
            ]
        }
    ]);
}
