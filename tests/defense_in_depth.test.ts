import { runTests } from "./framework.ts";

export async function testSandboxIsolationDefenseInDepth(t: any) {
    await runTests(t, [
        {
            name: "Global Deno Namespace Destruction",
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
        }]);
}

