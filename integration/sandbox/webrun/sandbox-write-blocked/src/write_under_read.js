export default async function(ctx) {
    const root = ctx.dir;
    try {
        const data = await root.getDirectoryHandle("data", { create: true });
        await data.getFileHandle("test.txt", { create: true });
    } catch (e) { console.error("BLOCKED:", e.message); throw e; }
}
