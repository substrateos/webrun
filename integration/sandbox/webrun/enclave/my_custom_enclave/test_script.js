export default async function(ctx) {
    const root = ctx.dir;
    const fileHandle = await root.getFileHandle("test.txt", { create: true });
    const writable = await fileHandle.createWritable();
    const writer = writable.getWriter();
    await writer.write("enclave_write");
    await writer.close();
    console.log("ENCLAVE_SUCCESS");
}
