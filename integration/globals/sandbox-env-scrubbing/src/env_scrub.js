export default async function(ctx) {
    if (typeof Deno !== 'undefined') {
        try {
            const secret = Deno.env.get("SUPER_SECRET_VAR");
            if (secret) { console.error("LEAKED:", secret); throw new Error("Leaked"); }
            else { console.log("SECURE"); }
        } catch (e) {
            console.error("DENO_BLOCKED:", e.message);
            throw e;
        }
    } else {
        console.error("DENO_BLOCKED: Runtime does not support Deno env mapping");
        throw new Error("Blocked");
    }
}
