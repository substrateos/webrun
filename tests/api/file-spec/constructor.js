export default async function(ctx) {
    const dir = ctx.dir;

    const jsFile = new File(["foo"], "test.txt", { lastModified: 12345, type: "text/plain" });
    if (!(jsFile instanceof File)) throw new Error("Global File constructor doesn't inherit from File");
    if (!(jsFile instanceof Blob)) throw new Error("Global File constructor doesn't inherit from Blob");
    if (jsFile.name !== "test.txt") throw new Error("Global File name mismatch");
    if (jsFile.lastModified !== 12345) throw new Error("Global File lastModified mismatch");
    if (jsFile.type !== "text/plain") throw new Error("Global File type mismatch");

    const dataDir = await dir.getDirectoryHandle("data", { create: true });
    const fileHandle = await dataDir.getFileHandle("temp.txt", { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write("hello w3c");
    await writable.close();

    const file = await fileHandle.getFile();
    if (!(file instanceof File)) throw new Error("SandboxFile does not inherit from File");
    if (!(file instanceof Blob)) throw new Error("SandboxFile does not inherit from Blob");
    if (file.name !== "temp.txt") throw new Error("SandboxFile missing name");
    if (file.size !== 9) throw new Error("SandboxFile size mismatch");
    if (typeof file.lastModified !== "number") throw new Error("SandboxFile missing lastModified timestamp");
    if (file.lastModified === 0) throw new Error("SandboxFile lastModified is 0");

    console.log("SUCCESS");
}
