export default async function(ctx) {
    const dir = ctx.dir;
    const dataDir = await dir.getDirectoryHandle("data", { create: true });
    const fh = await dataDir.getFileHandle("sync_cursor.bin", { create: true });
    const syncHandle = await fh.createSyncAccessHandle();
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    const wBytes = syncHandle.write(enc.encode("abcdef"));
    if (wBytes !== 6) throw new Error("Write bytes mismatch: " + wBytes);

    const wBytes2 = syncHandle.write(enc.encode("gh"));
    if (wBytes2 !== 2) throw new Error("Append bytes mismatch: " + wBytes2);

    const readBuf = new Uint8Array(8);
    const rBytes = syncHandle.read(readBuf, { at: 0 });
    if (rBytes !== 8) throw new Error("Read bytes mismatch: " + rBytes);
    if (dec.decode(readBuf) !== "abcdefgh") throw new Error("Data mismatch: " + dec.decode(readBuf));

    syncHandle.write(enc.encode("XY"), { at: 2 });

    const verifyBuf = new Uint8Array(8);
    syncHandle.read(verifyBuf, { at: 0 });
    if (dec.decode(verifyBuf) !== "abXYefgh") throw new Error("Positional write failed: " + dec.decode(verifyBuf));

    syncHandle.close();
    console.log("SYNC_CURSOR_OK");
}
