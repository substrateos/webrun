import { runTests } from "./framework.ts";

export async function testSandboxIsolationImportMap(t: any) {
    await runTests(t, [
        {
            name: "Valid Import Map Resolution",
            args: ["src/test.js"],
            configs: { ".": { importMap: "import_map.json", permissions: { storage: { ".": { access: "read" } } } } },
            files: {
                "import_map.json": JSON.stringify({ imports: { "@lib/": "./shared_lib/" } }),
                "shared_lib/math.ts": "export function add(a, b) { return a + b; }",
            },
            scripts: {
                "src/test.js": `
            import { add } from "@lib/math.ts";
            export default async function(ctx) {
                if (add(2, 3) !== 5) throw new Error("Math failed");
                console.log("IMPORT_SUCCESS");
            }
        `
            },
            expectCode: 0,
            expectStdout: "IMPORT_SUCCESS"
        },
        {
            name: "Sandbox I/O Integrity (The Breakout Attempt)",
            args: ["src/test.js"],
            configs: { ".": { importMap: "import_map.json", permissions: { storage: { ".": { access: "read" } } } } },
            files: {
                "import_map.json": JSON.stringify({ imports: { "@lib/": "./shared_lib/" } }),
                "shared_lib/math.ts": "export function add(a, b) { return a + b; }",
            },
            scripts: {
                "src/test.js": `
            import { add } from "@lib/math.ts";
            export default async function(ctx) {
                if (add(2, 3) !== 5) throw new Error("Math failed");
                
                const root = ctx.dir;
                try {
                    await root.getFileHandle("shared_lib/math.ts");
                } catch (e) {
                    if (e.name === "SecurityError" || e.name === "NotFoundError" || e.name === "TypeError") { // Enclave blocks
                        console.error("BLOCKED:", e.message);
                        throw e;
                    }
                }
                throw new Error("Breakout succeeded");
            }
        `
            },
            expectCode: 1,
            expectStderr: "BLOCKED:"
        }]);
}

