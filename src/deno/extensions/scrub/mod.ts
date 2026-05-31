/**
 * @webrun/deno/scrub — Global scrubbing extension (privilege boundary).
 *
 * This extension is the last privileged extension in the cascade.
 * It patches the Worker constructor to inherit sandbox restrictions,
 * then wipes all dangerous runtime globals (Deno, process, Buffer, etc.).
 *
 * Everything downstream of this extension runs in the clean sandbox.
 */
import type { Extension } from "../../../extensions/mod.ts";

const scrubExt: Extension = async (ctx, next, _config) => {
    const memoryMB = ctx.limits?.memoryMB;

    // 2. Patch Worker constructor to scrub globals in child workers
    const OriginalWorker = (globalThis as any).Worker;
    if (OriginalWorker) {
        (globalThis as any).Worker = class SandboxWorker extends OriginalWorker {
            constructor(specifier: string | URL, options?: any) {
                const finalOptions = {
                    ...options,
                    type: "module",
                    deno: { permissions: "inherit" },
                };

                const targetUrl = typeof specifier === 'string' ? specifier : specifier.href;
                const injection = `
                    if (!self.performance) self.performance = {};
                    const _memoryUsage = self.Deno.memoryUsage.bind(self.Deno);
                    Object.defineProperty(self.performance, 'memory', {
                        get: () => {
                            const usage = _memoryUsage();
                            return {
                                jsHeapSizeLimit: ${memoryMB ? memoryMB * 1024 * 1024 : 4294967296},
                                totalJSHeapSize: usage.heapTotal || usage.rss,
                                usedJSHeapSize: usage.heapUsed || usage.rss
                            };
                        },
                        configurable: true
                    });
                    self.performance.measureMemory = async () => {
                         const usage = _memoryUsage();
                         const bytes = usage.heapUsed || usage.rss;
                         return {
                             bytes,
                             breakdown: [{ bytes, attribution: [], types: ["Window"] }]
                         };
                    };
                    delete self.process;
                    delete self.Buffer;
                    delete self.global;
                    delete self.setImmediate;
                    delete self.clearImmediate;
                    delete self.Deno;
                    import * as mod from ${JSON.stringify(targetUrl)};
                `;
                const injectedSpecifier = `data:application/javascript,${encodeURIComponent(injection)}`;

                try {
                    super(injectedSpecifier, finalOptions);
                } catch (originalError) {
                    try {
                        const fallbackOptions = { type: finalOptions.type };
                        super(injectedSpecifier, fallbackOptions);
                    } catch (_) {
                        throw originalError;
                    }
                }
            }
        };
        Object.defineProperty((globalThis as any).Worker, 'name', { value: 'Worker', configurable: true });
    }

    // 3. Wipe dangerous globals
    delete (globalThis as any).Deno;
    delete (globalThis as any).process;
    delete (globalThis as any).Buffer;
    delete (globalThis as any).setImmediate;
    delete (globalThis as any).clearImmediate;
    delete (globalThis as any).global;

    // Everything downstream runs in the scrubbed environment
    return next(ctx);
};

export default scrubExt;
