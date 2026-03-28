export default async function(ctx) {
    try { await import("node:fs"); }
    catch (e) { console.error("BLOCKED:", e.message); throw e; }
}
