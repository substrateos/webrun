export default async function() {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle("ephemeral.txt", { create: true });
    const writable = await handle.createWritable();
    await writable.write("SHOULD_NOT_PERSIST");
    await writable.close();
}
