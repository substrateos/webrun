export default async function(ctx) {
    if (!ctx.tty) { console.log("NO_TTY"); return; }

    // Verify initial state
    if (ctx.tty.isRaw !== false) {
        throw new Error("Expected isRaw to be false initially, got " + ctx.tty.isRaw);
    }
    console.log("INITIAL_RAW=" + ctx.tty.isRaw);

    // Verify columns and rows are positive integers
    const cols = ctx.tty.columns;
    const rows = ctx.tty.rows;
    if (typeof cols !== "number" || cols <= 0 || !Number.isInteger(cols)) {
        throw new Error("Expected columns to be a positive integer, got " + cols);
    }
    if (typeof rows !== "number" || rows <= 0 || !Number.isInteger(rows)) {
        throw new Error("Expected rows to be a positive integer, got " + rows);
    }
    console.log("COLS=" + cols);
    console.log("ROWS=" + rows);

    // Set raw mode and verify
    await ctx.tty.setRawMode(true);
    if (ctx.tty.isRaw !== true) {
        throw new Error("Expected isRaw to be true after setRawMode(true)");
    }
    console.log("RAW_SET=" + ctx.tty.isRaw);

    // Restore cooked mode and verify
    await ctx.tty.setRawMode(false);
    if (ctx.tty.isRaw !== false) {
        throw new Error("Expected isRaw to be false after setRawMode(false)");
    }
    console.log("RAW_RESTORED=" + ctx.tty.isRaw);

    console.log("LIFECYCLE_OK");
}
