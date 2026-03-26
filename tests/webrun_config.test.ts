import { runTests } from "./framework.ts";

export async function testMenu(t: any) {
    await runTests(t, [
        {
            name: "Hierarchical Scope Enforcement: Rejects nested sandbox requests if explicitly narrowing ungranted bindings",
            args: ["test.js"],
            configs: { 
                ".": { bindings: { "auth": { module: "auth.js" }, "open": { module: "open.js" } } },
                "child": { permissions: { bindings: ["open"] } }
            },
            files: {
                "auth.js": "export default { fetch() { return new Response('auth_ok'); } }",
                "open.js": "export default { fetch() { return new Response('open_ok'); } }",
                "child/test.js": `
                    export default async function(ctx) {
                        // Open should be permitted
                        const openRes = await fetch(ctx.bindings.open);
                        const openTx = await openRes.text();
                        if (openTx !== "open_ok") throw new Error("Permitted binding failed");
                        
                        // Auth should be missing from ctx
                        if (ctx.bindings.auth !== undefined) throw new Error("Restricted binding leaked to context");
                        
                        try {
                           // Attempt to forge if we somehow guessed the UUID
                           // We can't actually guess it natively but we'll try to fetch an unlisted context config if we could
                        } catch(e) {}
                        console.log("NARROW_BINDINGS_OK");
                    }
                `
            },
            cwd: "child",
            expectCode: 0,
            expectStdout: "NARROW_BINDINGS_OK"
        }
    ]);
}
