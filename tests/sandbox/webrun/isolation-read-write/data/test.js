export default async function(ctx) {
    const root = ctx.dir;
    if (ctx.persisted !== true) throw new Error("Expected PWD to be persisted");
    const fileHandle = await root.getFileHandle("test_write.txt", { create: true });
    const writable = await fileHandle.createWritable();
    const writer = writable.getWriter();
    await writer.write("hello");
    await writer.close();
    console.log("SUCCESS");
}
