import { runTests } from "./framework.ts";

export async function testSandboxIsolationOPFS(t: any) {
    await runTests(t, [
        {
            name: "Provides an isolated workspace accessible via getDirectory()",
            args: ["src/test.js"],
            configs: { ".": {} },
            scripts: {
                "src/test.js": async (ctx: any) => {
                    const root = await navigator.storage.getDirectory();
                    const fh = await root.getFileHandle("opfs_test.txt", { create: true });
                    const w = await fh.createWritable();
                    await w.write("opfs_isolated_data");
                    await w.close();

                    const r = await fh.getFile();
                    const text = await r.text();

                    if (text !== "opfs_isolated_data") throw new Error("OPFS read/write mismatch");

                    const isPersisted = await navigator.storage.persisted();
                    if (isPersisted !== false) throw new Error("OPFS should report as not persisted");

                    console.log("OPFS_OK");
                }
            },
            expectCode: 0,
            expectStdout: "OPFS_OK"
        }]);
}

