import { runTests } from "./framework.ts";

export async function testSandboxIsolationImportMapSinkhole(t: any) {
    await runTests(t, [
        {
            name: "Node Sinkhole Preservation",
            args: ["src/test.js"],
            configs: { ".": { importMap: "import_map.json", permissions: { storage: { ".": { access: "read" } } } } },
            files: {
                "import_map.json": JSON.stringify({ imports: {} })
            },
            scripts: {
                "src/test.js": `
            import fs from "node:fs";
            export default async function(ctx) {
                console.log("WE SHOULD NOT REACH THIS");
            }
        `
            },
            expectCode: 1,
            expectStderr: "Node/NPM modules are blocked"
        },
        {
            name: "Proves importing from import map does not subvert user storage permissions",
            args: ["test.js"],
            configs: { ".": { importMap: "import_map.json", permissions: { storage: { "src": { access: "read" } } } } },
            files: {
                "import_map.json": JSON.stringify({ imports: { "@lib/": "./lib/" } }),
                "lib/math.ts": "export const MAGIC = 42;"
            },
            cwd: "src",
            scripts: {
                "src/test.js": `
            import { MAGIC } from "@lib/math.ts";
            export default async function(ctx) {
                console.log("SECRET_READ:", MAGIC);
            }
        `
            },
            expectCode: 1,
            expectStderr: "Requires read access to"
        }]);
}

