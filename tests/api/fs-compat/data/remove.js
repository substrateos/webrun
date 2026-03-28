export default async function(ctx) {
    const root = ctx.dir;

    await root.getFileHandle("to_delete.txt", { create: true });
    await root.removeEntry("to_delete.txt");

    try {
        await root.getFileHandle("to_delete.txt", { create: false });
    } catch (e) {
        if (e.name === "NotFoundError") {
            console.log("REMOVED_SUCCESS");
            return;
        }
        throw e;
    }
    throw new Error("File was not removed");
}
