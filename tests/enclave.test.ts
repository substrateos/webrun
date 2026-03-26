import { runTests } from "./framework.ts";

export async function testSandboxIsolationEnclave(t: any) {
    await runTests(t, [{
        name: "Obeys dynamic webrun.json filesystem scope limits per-execution",
        args: ["test_script.js"],
        configs: { ".": { permissions: { storage: { "my_custom_enclave": { access: "write" } } } } },
        files: {
            "my_custom_enclave/.keep": ""
        },
        cwd: "my_custom_enclave",
        scripts: {
            "my_custom_enclave/test_script.js": async (ctx: any) => {
                const { args, env } = ctx;
                const root = ctx.dir;
                const fileHandle = await root.getFileHandle("test.txt", { create: true });
                const writable = await fileHandle.createWritable();
                const writer = writable.getWriter();
                await writer.write("enclave_write");
                await writer.close();
                console.log("ENCLAVE_SUCCESS");
            }
        },
        expectCode: 0,
        expectStdout: "ENCLAVE_SUCCESS"
    }]);
}

