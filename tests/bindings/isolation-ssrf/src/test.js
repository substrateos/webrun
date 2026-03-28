export default async function(ctx) {
    try { await fetch("http://127.0.0.1:8080"); }
    catch (e) { console.error("BLOCKED:", e.message); throw e; }
}
