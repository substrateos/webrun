// extensions/check/mod.ts — @webrun/check extension.
//
// Short-circuits execution when --check-only is present.
// Delegates to the host runtime's type checker via @check.

import type { Context } from "../../core/types.ts";
import type { Extension } from "../mod.ts";

const check: Extension = async (
    ctx: Context,
    next: (ctx: Context) => Promise<void>,
    _config: Record<string, unknown>,
): Promise<void> => {
    if (!ctx.flags["check-only"]) return next(ctx);
    if (!ctx.location) {
        ctx.exit(127);
        return;
    }

    const handle = await ctx.run(["@check", ctx.location]);
    if (ctx.stdout) handle.stdout.pipeTo(ctx.stdout).catch((e: unknown) => console.warn("[webrun] check stdout pipe error:", e));
    if (ctx.stderr) handle.stderr.pipeTo(ctx.stderr).catch((e: unknown) => console.warn("[webrun] check stderr pipe error:", e));
    const exitCode = await handle.exitCode;
    ctx.exit(exitCode);
};

export default check;
