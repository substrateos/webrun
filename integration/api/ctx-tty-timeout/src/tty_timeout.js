export default async function(ctx) {
    if (!ctx.tty) { 
        console.log("RAW_ENABLED (NO TTY)"); 
        while(true) {}
    }
    await ctx.tty.setRawMode(true);
    console.log("RAW_ENABLED");
    while(true) {}
}
