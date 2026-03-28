export default async function(ctx) {
    let blocked = false;
    try {
        await fetch("webrun://arbitrary_forged_name/api");
    } catch (e) {
        if (e.message.includes("No binding mapped") || e.message.includes("Failed to fetch")) {
            blocked = true;
        }
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
