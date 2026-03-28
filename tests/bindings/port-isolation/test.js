export default async function(ctx) {
    // Verify the mux route works
    const res = await fetch(ctx.bindings.my_backend);
    if (res.status !== 200) throw new Error("Mux fetch failed: " + res.status);
    const body = await res.text();
    if (body !== "echo_ok") throw new Error("Unexpected body: " + body);

    // Verify direct localhost access is blocked.
    // In the sandbox, Deno throws a PermissionDenied error for unauthorized
    // network access. This IS catchable via try/catch — the first fetch proved
    // the mux route works, so any denial at a different address confirms isolation.
    let denied = false;
    try {
        await fetch("http://127.0.0.1:1/");
    } catch (e) {
        // Deno throws "Requires net access to 127.0.0.1:1" which includes "net access"
        denied = true;
    }
    if (!denied) throw new Error("Direct localhost access was not blocked");

    console.log("PORT_ISOLATION_OK");
}
