import { runTests } from "./framework.ts";

export async function testSandboxIsolationStorage(t: any) {
    await runTests(t, [
        {
            name: "Falls back to temporary dir if webrun.json is missing",
            args: ["src/test.js"],
            scripts: {
                "src/test.js": async (ctx: any) => {
                    const { args, env } = ctx;
                    const root = ctx.dir;
                    if (ctx.persisted !== false) throw new Error("Expected temp dir to not be persisted");
                    const fh = await root.getFileHandle("temp.txt", { create: true });
                    if (!fh) throw new Error("Could not create temp file");
                    const w = await fh.createWritable();
                    const writer = w.getWriter();
                    await writer.write("ok");
                    await writer.close();
                    const r = await fh.getFile();
                    const text = await r.text();
                    if (text !== "ok") throw new Error("Could not read from temp");
                }
            },
            expectCode: 0
        },
        {
            name: "Falls back to temporary dir if webrun.json has no storage allowlist",
            args: ["src/test.js"],
            configs: { ".": {} },
            files: {},
            scripts: {
                "src/test.js": async (ctx: any) => {
                    const { args, env } = ctx;
                    const root = ctx.dir;
                    if (ctx.persisted !== false) throw new Error("Expected temp dir to not be persisted");
                    const fh = await root.getFileHandle("temp.txt", { create: true });
                    if (!fh) throw new Error("Could not create temp file");
                    const w = await fh.createWritable();
                    const writer = w.getWriter();
                    await writer.write("ok");
                    await writer.close();
                    const r = await fh.getFile();
                    const text = await r.text();
                    if (text !== "ok") throw new Error("Could not read from temp");
                }
            },
            expectCode: 0
        }]);
}

