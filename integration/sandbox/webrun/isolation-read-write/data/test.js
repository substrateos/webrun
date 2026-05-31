export default async function(ctx) {
    const root = ctx.dir;
    if (!root) throw new Error("Expected PWD dir to be available when storage is declared");
    const fh = await root.getFileHandle("temp.txt", { create: true });
    if (!fh) throw new Error("Could not create temp file");
    const w = await fh.createWritable();
    const writer = w.getWriter();
    await writer.write("ok");
    await writer.close();
    const r = await fh.getFile();
    const text = await r.text();
    if (text !== "ok") throw new Error("Could not read from temp");
    console.log("SUCCESS");
}
