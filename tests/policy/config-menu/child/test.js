export default async function(ctx) {
    // Open should be permitted
    const openRes = await ctx.bindings.open.fetch("/");
    const openTx = await openRes.text();
    if (openTx !== "open_ok") throw new Error("Permitted binding failed");

    // Auth should be missing from ctx
    if (ctx.bindings.auth !== undefined) throw new Error("Restricted binding leaked to context");

    console.log("NARROW_BINDINGS_OK");
}
