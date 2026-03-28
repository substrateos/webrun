export default async function(ctx) {
    const root = ctx.dir;
    const fh = await root.getFileHandle("positional.txt", { create: true });

    const w1 = await fh.createWritable();
    await w1.write("hello world");
    await w1.close();

    const w3 = await fh.createWritable();
    await w3.write("hello world");
    await w3.write({ type: "write", position: 0, data: "juno " });
    await w3.close();

    const r = await fh.getFile();
    const text = await r.text();
    if (text !== "juno  world") throw new Error("Positional write failed: " + text);

    const w4 = await fh.createWritable();
    await w4.write("truncate_me_down");
    await w4.truncate(8);
    await w4.close();

    const r2 = await fh.getFile();
    const text2 = await r2.text();
    if (text2 !== "truncate") throw new Error("Truncate failed: " + text2);
}
