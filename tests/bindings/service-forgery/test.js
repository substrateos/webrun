export default async function(ctx) {
    // With per-binding .fetch closures, there is no global webrun:// protocol.
    // Attempting to fetch a webrun:// URL should fail because it's not a real
    // network protocol — Deno's native fetch rejects it.
    let blocked = false;
    try {
        await fetch("webrun://arbitrary_forged_name/api");
    } catch (e) {
        // Any error means the forged URL didn't route anywhere.
        blocked = true;
    }
    if (!blocked) throw new Error("Sandbox failed to block forged binding name schema fetch");

    blocked = false;
    try {
        await fetch("http://127.0.0.1:49152/api");
    } catch(e) {
        // With mux proxy, localhost access is blocked by Deno's --deny-net permission layer
        if (e.message.includes("Requires net access") || e.message.includes("not allowed") || e.message.includes("SSRF Blocked") || e.message.includes("denied")) blocked = true;
    }
    if (!blocked) throw new Error("Sandbox failed to block direct localhost port fetching");

    console.log("FORGERY_BLOCK_OK");
}
