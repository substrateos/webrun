export default async function(ctx) {
    const dir = ctx.dir;
    const dataDir = await dir.getDirectoryHandle("data", { create: true });

    await dataDir.getDirectoryHandle("subdir", { create: true });
    try {
        await dataDir.getFileHandle("subdir");
        throw new Error("Should have thrown TypeMismatchError");
    } catch (e) {
        if (e.name !== "TypeMismatchError") throw new Error("Expected TypeMismatchError, got: " + e.name + ": " + e.message);
    }

    try {
        await dataDir.getFileHandle("nonexistent.txt");
        throw new Error("Should have thrown NotFoundError");
    } catch (e) {
        if (e.name !== "NotFoundError") throw new Error("Expected NotFoundError, got: " + e.name + ": " + e.message);
    }

    try {
        await dataDir.getDirectoryHandle("nonexistent_dir");
        throw new Error("Should have thrown NotFoundError");
    } catch (e) {
        if (e.name !== "NotFoundError") throw new Error("Expected NotFoundError, got: " + e.name + ": " + e.message);
    }

    try {
        await dataDir.removeEntry("ghost.txt");
        throw new Error("Should have thrown NotFoundError");
    } catch (e) {
        if (e.name !== "NotFoundError") throw new Error("Expected NotFoundError, got: " + e.name + ": " + e.message);
    }

    console.log("ERRORS_OK");
}
