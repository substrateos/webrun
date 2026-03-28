export default async function(ctx) {
    const root = ctx.dir;
    const fh = await root.getFileHandle("binary.bin", { create: true });
    const w = await fh.createWritable();
    await w.write(new Uint8Array([0x01, 0x02, 0x03]));
    await w.close();

    const file = await fh.getFile();
    const buf = await file.arrayBuffer();
    const view = new Uint8Array(buf);

    if (view.length !== 3 || view[0] !== 1 || view[1] !== 2 || view[2] !== 3) {
        throw new Error("arrayBuffer() corrupted data");
    }
    console.log("ARRAYBUFFER_OK");
}
