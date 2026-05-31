export default async function() {
    const dir = await navigator.storage.getDirectory();
    try {
        await dir.getFileHandle("ephemeral.txt");
        throw new Error("LEAKED: ephemeral OPFS file persisted across runs");
    } catch (e) {
        if (e.message.includes("LEAKED")) throw e;
        // Expected: NotFoundError => ephemeral cleanup worked
    }
}
