export default async function(ctx) {
    const dir = ctx.dir;
    const dataDir = await dir.getDirectoryHandle("data", { create: true });
    const fh = await dataDir.getFileHandle("eof.bin", { create: true });
    const syncHandle = await fh.createSyncAccessHandle();
    const enc = new TextEncoder();

    syncHandle.write(enc.encode("abc"));

    const buf = new Uint8Array(10);
    const rBytes = syncHandle.read(buf, { at: 100 });
    if (rBytes !== 0) throw new Error("Expected 0 bytes reading past EOF, got: " + rBytes);

    const buf2 = new Uint8Array(10);
    const rBytes2 = syncHandle.read(buf2, { at: 1 });
    if (rBytes2 !== 2) throw new Error("Expected 2 bytes straddling EOF, got: " + rBytes2);

    syncHandle.close();
    console.log("EOF_OK");
}
