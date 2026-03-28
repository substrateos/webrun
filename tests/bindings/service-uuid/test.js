export default async function(ctx) {
    if (!ctx.bindings.test_svc) throw new Error("Binding not injected");
    if (!ctx.bindings.test_svc.startsWith("webrun://")) throw new Error("URI schema is not webrun://");
    if (ctx.bindings.test_svc.includes("worker.js")) throw new Error("URI leaks physical path");
    console.log("UUID_INJECTION_OK");
}
