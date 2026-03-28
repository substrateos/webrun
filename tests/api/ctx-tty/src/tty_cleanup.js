export default async function(ctx) {
    if (!ctx.tty) { console.log("NO_TTY"); return; }

    // Set raw mode, then throw an exception.
    // webrun MUST restore cooked mode automatically.
    await ctx.tty.setRawMode(true);
    console.log("RAW_ENABLED");
    throw new Error("DELIBERATE_CRASH");
}
