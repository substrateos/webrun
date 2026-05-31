/**
 * @webrun/deno/memory — RSS memory monitor extension.
 *
 * Polls Deno.memoryUsage().rss every 500ms when limits.memoryMB is set.
 * Calls ctx.exit(137) if the process exceeds the configured limit.
 * Runs as a background interval alongside the downstream cascade.
 */
import type { Extension } from "../../../extensions/mod.ts";
import { printFatalError } from "../../../core/log.ts";

const OOM_EXIT_CODE = 137;
const POLL_INTERVAL_MS = 500;
const BYTES_PER_MB = 1024 * 1024;

const memoryExt: Extension = async (ctx, next, _config) => {
    const memoryMB = ctx.limits?.memoryMB;
    if (!memoryMB) return next(ctx);

    const MAX_RSS_BYTES = memoryMB * BYTES_PER_MB;
    const getMemoryUsage = (globalThis as any).Deno?.memoryUsage;

    if (typeof getMemoryUsage !== "function") return next(ctx);

    const timer = setInterval(() => {
        const usage = getMemoryUsage();
        if (usage.rss > MAX_RSS_BYTES) {
            const currentMB = (usage.rss / BYTES_PER_MB).toFixed(2);
            printFatalError(`Memory limit exceeded!`, `Current: ${currentMB}MB / Allowed: ${memoryMB}MB`);
            clearInterval(timer);
            ctx.exit(OOM_EXIT_CODE);
        }
    }, POLL_INTERVAL_MS);

    try {
        return await next(ctx);
    } finally {
        clearInterval(timer);
    }
};

export default memoryExt;
