export default async function(ctx) {
    const res = await fetch(ctx.bindings.backend);
    const text = await res.text();
    if (text !== "OK") throw new Error("Backend not OK");
    console.log("ZOMBIE_TEST_FINISHED");
}
