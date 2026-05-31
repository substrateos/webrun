export default async function(ctx) {
    // Verify tty is available on ctx (may be null or an object)
    if (ctx.tty === null || (typeof ctx.tty === "object" && ctx.tty !== null)) {
        console.log("TTY_IMPORT_OK");
    } else {
        throw new Error("Expected ctx.tty to be null or object, got " + typeof ctx.tty);
    }
}
