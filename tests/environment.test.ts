import { runTests } from "./framework.ts";

export async function testSandboxIsolationEnvironment(t: any) {
    await runTests(t, [
        {
            name: "Injects host environment variables explicitly requested by string array",
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
        }]);
}

