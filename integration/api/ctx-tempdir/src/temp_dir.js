export default async function(ctx) {
    const dirHandle = await ctx.makeTempDir();
    if (!dirHandle || typeof dirHandle.getFileHandle !== 'function') {
        throw new Error("Invalid directory handle returned");
    }
    
    // Write x.txt
    const fileHandle = await dirHandle.getFileHandle("x.txt", { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write("Hello W3C");
    await writable.close();
    
    // Read x.txt back
    const readHandle = await dirHandle.getFileHandle("x.txt");
    const file = await readHandle.getFile();
    const text = await file.text();
    
    if (text !== "Hello W3C") {
        throw new Error("Text mismatch: " + text);
    }
    
    console.log("SUCCESS");
}
