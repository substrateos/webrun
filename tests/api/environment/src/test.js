export default async function(ctx) {
    const val = ctx.env.MY_HOST_VAR;
    if (val !== "host_injected_value") {
        console.error("FAILED match, got: " + val);
        throw new Error("Missing or mapping mismatch: " + val);
    }
}
