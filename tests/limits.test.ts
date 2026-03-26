import { runTests } from "./framework.ts";

export async function testSandboxIsolationLimits(t: any) {
    await runTests(t, [
        {
            name: "Aborts runaway processes via webrun.json configurable timeout",
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
        }]);
}

