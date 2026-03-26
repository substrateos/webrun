import { runTests } from "./framework.ts";

export async function testSandboxIsolationNetwork(t: any) {
    await runTests(t, [
        {
            name: "Obeys dynamic webrun.json allowlists",
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
            name: "Rewrites synchronous Deno permission errors to provide WebRun configuration hints",
            args: ["src/test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
            scripts: {
                "src/test.js": async (ctx: any) => {
                    // Intentionally throw standard synchronous permission error natively
                    await fetch("https://example.com");
                }
            },
            expectCode: 1,
            expectStderr: [
                "Requires net access to \"example.com:443\".",
                "Hint: Update the 'permissions' object in your webrun.json to allow this operation."
            ]
        },
        {
            name: "Rewrites unhandled promise Deno permission errors to provide WebRun configuration hints",
            args: ["src/test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
            scripts: {
                "src/test.js": async (ctx: any) => {
                    // Intentionally dangling unhandled promise catching the unhandledrejection event
                    setTimeout(() => fetch("https://example.com"), 10);
                    await new Promise(r => setTimeout(r, 100));
                }
            },
            expectCode: 1,
            expectStderr: [
                "Requires net access to \"example.com:443\".",
                "Hint: Update the 'permissions' object in your webrun.json to allow this operation."
            ]
        }]);
}

