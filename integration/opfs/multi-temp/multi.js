export default async function(ctx) {
    const a = await ctx.makeTempDir();
    const b = await ctx.makeTempDir();

    // They must be different handles
    if (a.name === b.name) throw new Error("Handles share the same name");

    // Write to A, verify B does not see it
    const fh = await a.getFileHandle("only_in_a.txt", { create: true });
    const w = await fh.createWritable();
    await w.write("A_ONLY");
    await w.close();

    try {
        await b.getFileHandle("only_in_a.txt");
        throw new Error("B should not contain A's file");
    } catch (e) {
        if (!e.message.includes("could not be found")) throw e;
    }

    // Subdirectory support
    const sub = await a.getDirectoryHandle("nested", { create: true });
    const sf = await sub.getFileHandle("deep.txt", { create: true });
    const sw = await sf.createWritable();
    await sw.write("DEEP");
    await sw.close();
    const rd = await sub.getFileHandle("deep.txt");
    const file = await rd.getFile();
    if (await file.text() !== "DEEP") throw new Error("Subdirectory read failed");

    console.log("MULTI_OK");
}
