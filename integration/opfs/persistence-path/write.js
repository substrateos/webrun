export default async function() {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle("persisted.txt", { create: true });
    const writable = await handle.createWritable();
    await writable.write("HELLOOO");
    await writable.close();
}
