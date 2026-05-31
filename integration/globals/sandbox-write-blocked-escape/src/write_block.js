export default async function(ctx) {
    try {
        const root = ctx.dir;
        await root.getFileHandle("../../../../../../tmp/sandbox_escape.txt", { create: true });
    }
    catch (e) { console.error("BLOCKED:", e.message); throw e; }
}
