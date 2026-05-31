export default async function(ctx) {
    if (!ctx.tty) { 
        console.log("LIFECYCLE_OK (NO TTY)"); 
        return; 
    }
    if (await ctx.tty.isRaw() !== false) throw new Error("isRaw not false initially");
    console.log("INITIAL_RAW=" + await ctx.tty.isRaw());
    const { columns: cols, rows } = await ctx.tty.consoleSize();
    if (typeof cols !== "number" || cols <= 0) throw new Error("Bad columns: " + cols);
    if (typeof rows !== "number" || rows <= 0) throw new Error("Bad rows: " + rows);
    console.log("COLS=" + cols);
    console.log("ROWS=" + rows);
    await ctx.tty.setRawMode(true);
    if (await ctx.tty.isRaw() !== true) throw new Error("isRaw not true after setRawMode(true)");
    console.log("RAW_SET=" + await ctx.tty.isRaw());
    await ctx.tty.setRawMode(false);
    if (await ctx.tty.isRaw() !== false) throw new Error("isRaw not false after restore");
    console.log("RAW_RESTORED=" + await ctx.tty.isRaw());
    console.log("LIFECYCLE_OK");
}
