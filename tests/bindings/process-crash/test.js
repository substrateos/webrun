export default async function(ctx) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(ctx.bindings.crash_backend);
    if (res.status !== 502) {
        throw new Error(`Expected 502 for crashed backend, got ${res.status}`);
    }
    const body = await res.text();
    if (!body.includes("Connection refused") && !body.includes("error sending request") && !body.includes("connection closed")) {
        throw new Error("502 body missing connection error detail: " + body);
    }
    console.log("CRASH_PROXY_OK");
}
