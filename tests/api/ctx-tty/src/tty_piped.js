export default async function(ctx) {
    // When the batch case runner spawns this script, stdin may be inherited
    // from the test runner (which is a real terminal during --self-test).
    // We verify that ctx.tty exists as an object OR is undefined depending
    // on the stdin configuration. The key contract: ctx.tty is present
    // if and only if stdin isTerminal().
    const hasTty = ctx.tty !== undefined;
    console.log("TTY_PRESENT=" + hasTty);
    if (hasTty) {
        // Validate shape when present
        if (typeof ctx.tty.setRawMode !== "function") throw new Error("setRawMode is not a function");
        if (typeof ctx.tty.isRaw !== "boolean") throw new Error("isRaw is not a boolean");
        if (typeof ctx.tty.columns !== "number") throw new Error("columns is not a number");
        if (typeof ctx.tty.rows !== "number") throw new Error("rows is not a number");
        console.log("TTY_SHAPE_OK");
    } else {
        console.log("TTY_UNDEFINED_OK");
    }
}
