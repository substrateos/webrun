export default async function(ctx) {
    const res = await ctx.bindings.ai.fetch("/", { method: "POST", body: "hello" });
    if (res.status !== 200) throw new Error("Failed proxy fetch");
    const text = await res.text();
    if (text !== "world_from_worker") throw new Error("IPC payload body mismatch: " + text);
    if (res.headers.get("x-custom") !== "Foo") throw new Error("IPC payload headers mismatch");
    console.log("FETCH_PROXY_OK");
}
