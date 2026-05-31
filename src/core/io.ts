export async function resolveDirectoryHandle(base: FileSystemDirectoryHandle, parts: string[]): Promise<FileSystemDirectoryHandle> {
    let handle = base;
    for (const part of parts) {
        handle = await handle.getDirectoryHandle(part);
    }
    return handle;
}

export async function readTextFile(base: FileSystemDirectoryHandle, parts: string[]): Promise<string> {
    parts = parts.filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) throw new Error("Invalid path");
    const dir = await resolveDirectoryHandle(base, parts);
    const fileHandle = await dir.getFileHandle(fileName, { create: false });
    const file = await fileHandle.getFile();
    return await file.text();
}

export async function writeTextFile(base: FileSystemDirectoryHandle, parts: string[], content: string): Promise<void> {
    parts = parts.filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) throw new Error("Invalid path");
    let curr = base;
    for (const part of parts) {
        curr = await curr.getDirectoryHandle(part, { create: true });
    }
    const fileHandle = await curr.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
}
