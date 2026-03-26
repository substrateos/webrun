import { runTests } from "./framework.ts";

export async function testSandboxIsolationConfiguration(t: any) {
    await runTests(t, [
        {
            name: "Discovers and applies \"webrun\" key natively via package.json fallback schema",
            args: ["test_pkg.js"],
            files: { "package.json": JSON.stringify({ name: "pkg_test", webrun: { permissions: { storage: { "testing_dir": { access: "write" } } } } }), "testing_dir/.keep": "" },
            cwd: "testing_dir",
            scripts: {
                "testing_dir/test_pkg.js": async (ctx: any) => {
                    const { args, env } = ctx;
                    const root = ctx.dir;
                    const fh = await root.getFileHandle("test_write.txt", { create: true });
                    const w = await fh.createWritable();
                    await w.write("package_json_fallback_active");
                    await w.close();
                    console.log("PKG_JSON_FALLBACK_OK");
                }
            },
            expectCode: 0,
            expectStdout: "PKG_JSON_FALLBACK_OK"
        }]);
}

