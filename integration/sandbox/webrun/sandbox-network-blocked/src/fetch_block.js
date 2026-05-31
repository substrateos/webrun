export default async function(ctx) {
    try { await fetch("https://example.com"); }
    catch (e) { console.error("BLOCKED:", e.message); throw e; }
}
