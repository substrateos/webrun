export default async function(ctx) {
    // When the batch case runner spawns this script, stdin may be inherited
    // from the test runner (which is a real terminal during --self-test).
    // We verify that ctx.tty exists as an object OR is null depending
    // on the stdin configuration. The key contract: ctx.tty is present
    // if and only if stdin isTerminal().
    const hasTty = ctx.tty !== null && ctx.tty !== undefined;
    console.log("TTY_PRESENT=" + hasTty);
    if (hasTty) {
        // Validate shape when present — all methods are async
        if (typeof ctx.tty.setRawMode !== "function") throw new Error("setRawMode is not a function");
        if (typeof ctx.tty.isRaw !== "function") throw new Error("isRaw is not a function");
        if (typeof ctx.tty.consoleSize !== "function") throw new Error("consoleSize is not a function");
        const raw = await ctx.tty.isRaw();
        if (typeof raw !== "boolean") throw new Error("isRaw() did not return boolean");
        const size = await ctx.tty.consoleSize();
        if (typeof size.columns !== "number") throw new Error("columns is not a number");
        if (typeof size.rows !== "number") throw new Error("rows is not a number");
        console.log("TTY_SHAPE_OK");
    } else {
        console.log("TTY_UNDEFINED_OK");
    }
}
