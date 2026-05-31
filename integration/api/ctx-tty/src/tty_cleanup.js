export default async function(ctx) {
    if (!ctx.tty) { 
        console.log("RAW_ENABLED (NO TTY)"); 
        throw new Error("DELIBERATE_CRASH (NO TTY)"); 
    }
    await ctx.tty.setRawMode(true);
    console.log("RAW_ENABLED");
    throw new Error("DELIBERATE_CRASH");
}
