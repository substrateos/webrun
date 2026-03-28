export default async function(ctx) {
    const root = ctx.dir;
    try {
        await root.getFileHandle("../../etc/passwd");
    } catch (e) {
        if (e.name === "SecurityError") {
            console.log("BLOCKED_TRAVERSAL");
            return;
        }
        throw e;
    }
    throw new Error("Failed to block traversal");
}
