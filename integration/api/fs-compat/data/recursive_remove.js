export default async function(ctx) {
    const root = ctx.dir;
    const populated = await root.getDirectoryHandle("populated", { create: true });
    const fh = await populated.getFileHandle("deep.txt", { create: true });
    const w = await fh.createWritable();
    await w.write("test");
    await w.close();

    await root.removeEntry("populated", { recursive: true });

    try {
        await root.getDirectoryHandle("populated", { create: false });
    } catch (e) {
        if (e.name === "NotFoundError") {
            console.log("RECURSIVE_REMOVE_OK");
            return;
        }
        throw e;
    }
    throw new Error("Populated directory not removed");
}
