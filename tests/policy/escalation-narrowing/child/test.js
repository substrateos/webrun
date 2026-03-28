export default async function(ctx) {
    const { env, dir } = ctx;

    if (env.B !== undefined) throw new Error("Env B leaked");
    if (env.A !== "secret") throw new Error("Env A missing");

    const root = ctx.dir;

    // 1. Should fail to write to PWD (since narrowed to read-only)
    let blocked = false;
    try {
        const file = await root.getFileHandle("test_write.txt", { create: true });
        const w = await file.createWritable();
        await w.close();
    } catch (e) {
        blocked = true;
    }
    if (!blocked) throw new Error("Successfully wrote to read-only PWD");

    // 2. Should succeed writing to narrow_dir (granted write access)
    const narrow = await root.getDirectoryHandle("narrow_dir");
    const file = await narrow.getFileHandle("ok.txt", { create: true });
    const w = await file.createWritable();
    await w.write("val");
    await w.close();

    console.log("NARROW_SUCCESS");
}
