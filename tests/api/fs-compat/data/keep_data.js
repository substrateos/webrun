export default async function(ctx) {
    const root = ctx.dir;
    const fh = await root.getFileHandle("truncation_bug.txt", { create: true });

    const w1 = await fh.createWritable();
    await w1.write("abcdef");
    await w1.close();

    const w2 = await fh.createWritable({ keepExistingData: true });
    await w2.write({ type: "write", position: 0, data: "123" });
    await w2.close();

    const r = await fh.getFile();
    const text = await r.text();

    if (text !== "123def") {
        throw new Error(`keepExistingData failed! Expected '123def', got '${text}'`);
    }

    console.log("SUCCESS");
}
