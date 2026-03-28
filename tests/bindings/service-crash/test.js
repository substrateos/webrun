export default async function(ctx) {
    const res = await fetch(ctx.bindings.crash);
    if (res.status !== 500) throw new Error("Worker crash did not translate to HTTP 500");
    const text = await res.text();
    if (!text.includes("Simulated unhandled worker exception")) throw new Error("Error missing: " + text);
    console.log("CRASH_PROPAGATION_OK");
}
