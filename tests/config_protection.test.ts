import { runTests } from "./framework.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

export async function testSandboxIsolationConfigProtection(t: any) {
    await runTests(t, [
        {
            name: "Aborts if policy allows writing to the webrun executable directory",
            args: ["src/test.js"],
            preflight: async function (runDir: string, t: any) {
                const workerBin = t.WORKER_BIN;
                const binDir = workerBin.substring(0, workerBin.lastIndexOf("/")) || "/";
                const cfg = { permissions: { storage: { [binDir]: { access: "write" } } } };
                t.Deno.writeTextFileSync(join(runDir, "webrun.json"), JSON.stringify(cfg));
            },
            scripts: {
                "src/test.js": `
            export default async function(ctx) {
                console.log("ESCAPED");
            }
        `
            },
            expectCode: 1,
            expectStderr: [
                "[Security Fatal] The webrun file is within a permitted write directory. Refusing to run.",
                "  Executable:"
            ]
        },
        {
            name: "Aborts if policy allows writing to the top-level webrun.json directory",
            args: ["src/test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "write" } } } } },
            scripts: {
                "src/test.js": `
            export default async function(ctx) {
                console.log("ESCAPED");
            }
        `
            },
            expectCode: 1,
            expectStderr: [
                "[Security Fatal] The webrun file is within a permitted write directory. Refusing to run.",
                "  Executable:"
            ]
        },
        {
            name: "Aborts if policy allows writing to a child webrun.json directory",
            args: ["test.js"],
            configs: {
                ".": { permissions: { storage: { "child": { access: "write" } } } },
                "child": { permissions: { storage: { ".": { access: "write" } } } }
            },
            files: {
                "child/test.js": "export default async function(ctx) { console.log('ESCAPED'); }"
            },
            cwd: "child",
            expectCode: 1,
            expectStderr: [
                "[Security Fatal] The webrun file is within a permitted write directory. Refusing to run.",
                "  Executable:"
            ]
        }]);
}

