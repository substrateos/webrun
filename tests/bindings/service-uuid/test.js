export default async function(ctx) {
    if (!ctx.bindings.test_svc) throw new Error("Binding not injected");
    if (typeof ctx.bindings.test_svc.fetch !== "function") throw new Error("Binding missing .fetch method");
    console.log("UUID_INJECTION_OK");
}
