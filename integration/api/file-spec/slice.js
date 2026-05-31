export default async function(ctx) {
    const dir = ctx.dir;
    const dataDir = await dir.getDirectoryHandle("data", { create: true });
    const fh = await dataDir.getFileHandle("sliceable.bin", { create: true });
    const w = await fh.createWritable();
    const payload = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await w.write(payload);
    await w.close();

    const file = await fh.getFile();
    if (file.size !== 10) throw new Error("File size mismatch: " + file.size);

    const slice1 = file.slice(2, 6);
    if (slice1.size !== 4) throw new Error("Slice size mismatch: " + slice1.size);
    const buf1 = new Uint8Array(await slice1.arrayBuffer());
    if (buf1.length !== 4 || buf1[0] !== 2 || buf1[1] !== 3 || buf1[2] !== 4 || buf1[3] !== 5) {
        throw new Error("Slice data mismatch: " + Array.from(buf1));
    }

    const textFh = await dataDir.getFileHandle("sliceable.txt", { create: true });
    const tw = await textFh.createWritable();
    await tw.write("hello world");
    await tw.close();
    const textFile = await textFh.getFile();
    const textSlice = textFile.slice(6, 11);
    const sliceText = await textSlice.text();
    if (sliceText !== "world") throw new Error("Text slice mismatch: " + sliceText);

    const nested = textFile.slice(0, 5).slice(1, 4);
    const nestedText = await nested.text();
    if (nestedText !== "ell") throw new Error("Nested slice mismatch: " + nestedText);

    const fullSlice = textFile.slice();
    const fullText = await fullSlice.text();
    if (fullText !== "hello world") throw new Error("Full slice mismatch: " + fullText);

    console.log("SLICE_OK");
}
