export default async function() {
    const dir = await navigator.storage.getDirectory();
    try {
        const handle = await dir.getFileHandle("persisted.txt");
        const file = await handle.getFile();
        if (await file.text() !== "HELLOOO") throw new Error("Mismatch");
    } catch (e) {
        throw new Error("File missing or bad: " + e.message);
    }
}
