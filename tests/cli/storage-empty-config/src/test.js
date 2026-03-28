export default async function(ctx) {
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
