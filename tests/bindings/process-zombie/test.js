export default async function(ctx) {
    const res = await ctx.bindings.backend.fetch("/");
    const text = await res.text();
    if (text !== "OK") throw new Error("Backend not OK");
    console.log("ZOMBIE_TEST_FINISHED");
}
