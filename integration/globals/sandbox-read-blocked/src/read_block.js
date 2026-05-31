export default async function(ctx) {
    if (typeof Deno !== 'undefined') {
        try { Deno.readTextFileSync("/etc/passwd"); }
        catch (e) { console.error("BLOCKED:", e.message); throw e; }
    } else {
        console.error("BLOCKED: Runtime does not support file APIs");
        throw new Error("Fallback block");
    }
}
