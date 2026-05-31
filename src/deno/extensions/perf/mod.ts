/**
 * @webrun/deno/perf — Performance polyfill extension.
 *
 * Patches performance.memory and performance.measureMemory() to
 * return Deno memory usage. Runs before scrub so it can capture
 * Deno.memoryUsage while it's still available.
 */
import type { Extension } from "../../../extensions/mod.ts";

const perfExt: Extension = async (ctx, next, _config) => {
    const memoryUsage = (globalThis as any).Deno?.memoryUsage;
    if (typeof memoryUsage !== "function") return next(ctx);

    const memoryMB = ctx.limits?.memoryMB;

    if (!(globalThis as any).performance) {
        (globalThis as any).performance = {};
    }

    Object.defineProperty((globalThis as any).performance, 'memory', {
        get: () => {
            const usage = memoryUsage();
            return {
                jsHeapSizeLimit: memoryMB ? memoryMB * 1024 * 1024 : 4294967296,
                totalJSHeapSize: usage.heapTotal || usage.rss,
                usedJSHeapSize: usage.heapUsed || usage.rss,
            };
        },
        configurable: true,
    });

    (globalThis as any).performance.measureMemory = async () => {
        const usage = memoryUsage();
        const bytes = usage.heapUsed || usage.rss;
        return {
            bytes,
            breakdown: [{ bytes, attribution: [], types: ["Window"] }],
        };
    };

    return next(ctx);
};

export default perfExt;
