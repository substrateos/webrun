export default async function(ctx) {
    const root = ctx.dir;
    const subDir = await root.getDirectoryHandle("nested_dir", { create: true });
    if (subDir.name !== "nested_dir" || subDir.kind !== "directory") throw new Error("Directory handle invalid");

    const file = await subDir.getFileHandle("deep_file.txt", { create: true });
    const writable = await file.createWritable();
    const writer = writable.getWriter();
    await writer.write("deep_data");
    await writer.close();

    const r = await file.getFile();
    const text = await r.text();
    if (text !== "deep_data") throw new Error("Deep file data mismatch");

    console.log("NESTED_SUCCESS");
}
