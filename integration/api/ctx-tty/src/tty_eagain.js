export default async function(ctx) {
    if (!ctx.tty || !ctx.stdin) { 
        console.log("HANG_SUCCESS (NO TTY)"); 
        return; 
    }
    await ctx.tty.setRawMode(true);
    try {
        const reader = ctx.stdin.getReader();
        const v = await Promise.race([
            reader.read().catch(e => { throw new Error("READ_THREW: " + e.message); }),
            new Promise(r => setTimeout(() => r("HANG_SUCCESS"), 50))
        ]);
        console.log(v);
    } finally {
        await ctx.tty.setRawMode(false);
    }
}
