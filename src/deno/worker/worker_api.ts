/**
 * Worker-side implementation of WorkerAPI.
 *
 * Receives a ContextDescriptor + WorkerContext from the sandbox,
 * builds the full Context, runs the extension cascade, and
 * executes the user's module.
 */

import type { ContextDescriptor, WorkerAPI, WorkerContext, WorkerStdio } from "../../core/ipc.ts";
import type { Context, CoreContext, ExtensionContext, WebrunDefaultExport } from "../../core/types.ts";
import { makeMeta } from "../../core/meta.ts";
import { isRunArg, extractGrants } from "../../core/run_arg.ts";
import { securityError, SecurityViolation } from "../../core/types.ts";
import { validateSharedOptions } from "../../core/run/shared.ts";
import { resolveExtensions, type Extension } from "../../extensions/mod.ts";
import { rewriteForHumans } from "../../core/log.ts";
import makeSignal from "../sandbox/signal.ts";


class WebrunExitError extends Error {
    code: number;
    constructor(code: number) {
        super(`exit(${code})`);
        this.name = "WebrunExitError";
        this.code = code;
    }
}

/**
 * Build the extension cascade and execute.
 * Each extension receives an ExtensionContext with a scoped extension() closure.
 * The final next imports and runs the user's target module.
 */
function buildCascade(
    resolved: { ext: Extension; config: Record<string, unknown>; key: string }[],
    finalStep: (ctx: Context) => Promise<void>,
): (ctx: Context) => Promise<void> {
    let fn: (ctx: Context) => Promise<void> = finalStep;
    for (let i = resolved.length - 1; i >= 0; i--) {
        const { ext, config, key } = resolved[i];
        const next = fn;
        fn = (ctx) => {
            const extCtx: ExtensionContext = {
                ...ctx,
                extensionKey: key,
            };
            return ext(extCtx, next, config);
        };
    }
    return fn;
}

/**
 * The final step: import the user's module.
 *
 * If the descriptor has serve URLs, start the server using the module's
 * fetch export. If the module has a callable default, run it as main.
 * Both can coexist in one execution.
 */
function makeRunUserModule(
    descriptor: ContextDescriptor,
): (ctx: Context) => Promise<void> {
    return async (ctx: Context): Promise<void> => {
        if (!ctx.location) {
            ctx.exit(127);
        }

        const mod = await import(ctx.location)
        const def = mod.default as WebrunDefaultExport | undefined;
        const urls = descriptor.module?.urls ?? [];

        // Start serve listeners if the host configured serve URLs.
        if (urls.length > 0) {
            const handler = def && typeof def === 'object' && typeof def.fetch === 'function'
                ? (req: Request, serveCtx: any) => def.fetch!(req, { ...ctx, ...serveCtx })
                : async () => {
                    const res = await fetch(ctx.location);
                    return new Response(res.body, {
                        headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
                    });
                };
            await ctx.serve(handler, { listen: urls, signal: ctx.signal });

            // Keep the cascade open until the process is signalled to stop.
            await new Promise<void>(resolve => {
                if (ctx.signal.aborted) return resolve();
                ctx.signal.addEventListener("abort", () => resolve(), { once: true });
            });
        }

        if (typeof def === 'function') {
            await def(ctx);
        } else if (def && typeof def === 'object' && typeof def.main === 'function') {
            await def.main(ctx.args, ctx.env, ctx);
        }
        // No default export + no serve URLs = plain script.
        // Top-level code already executed during import().
    };
}

/**
 * Build a full Context from ContextDescriptor + WorkerContext.
 * The descriptor carries serializable config; WorkerContext carries
 * live callbacks (exit, run) from the sandbox.
 */
function buildContext(
    descriptor: ContextDescriptor,
    stdio: WorkerStdio,
    signal: AbortSignal,
    workerCtx: WorkerContext,
): Context {
    const mod = descriptor.module!;

    const exit = (code: number): never => {
        workerCtx.exit(code);
        throw new WebrunExitError(code);
    };

    // Build the meta URL: absolute paths become file:// URLs; URLs pass through.
    const targetUrl = mod.target.startsWith("/")
        ? `file://${mod.target}`
        : mod.target || "file:///";

    return {
        argv: Object.freeze([...mod.argv]),
        args: Object.freeze([...mod.args]),
        flags: Object.freeze({ ...mod.flags }),
        env: mod.env,
        dir: undefined!,
        location: mod.target,
        meta: makeMeta(targetUrl, mod.importMap, mod.fs.dir),

        permissions: mod.config.permissions,
        limits: mod.config.limits,
        importMap: mod.importMap,
        extensions: {},

        signal,
        stdin: stdio.stdin,
        stdout: stdio.stdout,
        stderr: stdio.stderr,
        tty: workerCtx.tty,

        run: (() => {
            const runFn: any = descriptor.caps.run
                ? async (args: any[], options?: any) => {
                    // Shared run: validate user-supplied options at the boundary,
                    // before IPC serialization adds internal plumbing fields.
                    if (options?.shared) {
                        validateSharedOptions([], options);
                    }

                    // Extract handle grants from RunArg args.
                    const argGrants = extractGrants(args);
                    const storageGrants = options?.storage || [];
                    const allGrants = [...argGrants, ...storageGrants];

                    // Stringify RunArg args for IPC.
                    const stringArgs = args.map((a: any) => isRunArg(a) ? a.value : String(a));

                    // Strip non-transferable fields before crossing IPC.
                    const ipcOptions = { ...options } as any;
                    delete ipcOptions.signal;
                    // Pass grants as serializable storage entries.
                    if (allGrants.length > 0) {
                        ipcOptions.storage = allGrants;
                    }

                    const handle = await workerCtx.run(stringArgs, ipcOptions);

                    // Wire AbortSignal → handle.signal() locally.
                    if (options?.signal) {
                        const forward = () => {
                            const sig = typeof options.signal!.reason === "string" ? options.signal!.reason : "SIGTERM";
                            handle.signal(sig);
                        };
                        if (options.signal.aborted) {
                            forward();
                        } else {
                            options.signal.addEventListener("abort", forward, { once: true });
                        }
                    }

                    return handle;
                }
                : () => { throw securityError("ctx.run() requires 'run' permission", { code: SecurityViolation.PermissionDenied, message: "ctx.run() requires 'run' permission", child: "", parent: "" }); };
            return runFn;
        })(),
        exit,
        makeTempDir: () => { throw new Error("makeTempDir requires the @webrun/file_system extension"); },
        createFileSystemHandleURL: () => { throw new Error("createFileSystemHandleURL requires the @webrun/file_system extension"); },
        serve: () => { throw new Error("serve requires the @webrun/serve extension"); },
        TCPSocket: class { constructor() { throw new Error("TCPSocket requires the @webrun/direct_sockets extension"); } } as any,
        extensionData: () => { throw new Error("extensionData requires the @webrun/file_system extension"); },
    };
}

/**
 * Install global error handlers that catch WebrunExitError and AbortError.
 * Must be called before the cascade runs.
 *
 * The unhandled rejection handler only force-exits when the guest has not
 * registered its own listener — allowing guest code (e.g. test harness) to
 * handle floating promise rejections gracefully.
 */
function setupErrorHandlers(workerCtx: WorkerContext) {
    // Track guest-registered unhandledrejection listeners so the default
    // exit behavior can be suppressed when the guest handles rejections itself.
    let guestRejectionListeners = 0;
    const origAdd = globalThis.addEventListener;
    globalThis.addEventListener = function (type: string, ...args: any[]) {
        if (type === 'unhandledrejection') guestRejectionListeners++;
        return Reflect.apply(origAdd, globalThis, [type, ...args]);
    } as typeof globalThis.addEventListener;

    const origRemove = globalThis.removeEventListener;
    globalThis.removeEventListener = function (type: string, ...args: any[]) {
        if (type === 'unhandledrejection') guestRejectionListeners = Math.max(0, guestRejectionListeners - 1);
        return Reflect.apply(origRemove, globalThis, [type, ...args]);
    } as typeof globalThis.removeEventListener;

    origAdd('unhandledrejection', (e: PromiseRejectionEvent) => {
        const reason = e.reason;
        if (reason?.name === "WebrunExitError") {
            e.preventDefault();
            workerCtx.exit(reason.code);
            return;
        }
        if (reason?.name === "AbortError") {
            e.preventDefault();
            return;
        }
        // If the guest has its own listener, let it handle the rejection.
        if (guestRejectionListeners > 0) return;
        e.preventDefault();
        const msg = reason instanceof Error ? reason.message : String(reason?.message || reason);
        // TODO should have an onunhandledrejection callback instead of writing to console.error and exiting
        console.error("Unhandled promise rejection:", rewriteForHumans(msg));
        workerCtx.exit(1);
    });

    origAdd('error', (e: ErrorEvent) => {
        const err = e.error;
        if (err?.name === "WebrunExitError") {
            e.preventDefault();
            workerCtx.exit(err.code);
            return;
        }
        if (err?.name === "AbortError") {
            e.preventDefault();
            return;
        }
        e.preventDefault();
        const stack = err?.stack || err?.message || e.message || String(err);
        // TODO should have an onerror callback instead of writing to console.error and exiting
        console.error("Uncaught Error:", rewriteForHumans(stack));
        workerCtx.exit(1);
    });
}

/**
 * WorkerAPI implementation.
 * Called once by the sandbox via IPC after the worker is spawned.
 */
export default function createWorkerAPI(): WorkerAPI {
    return {
        async init(descriptor, stdio, sandboxAPI, ports): Promise<void> {
            const signal = makeSignal({
                addSignalListener: Deno.addSignalListener,
                exit: (code = 0) => sandboxAPI.exit(code),
            });
            sandboxAPI.onAbort(() => {
                if (!signal.aborted) {
                    signal.dispatchEvent(new Event("SIGTERM", { cancelable: true }));
                }
            });

            setupErrorHandlers(sandboxAPI);

            const ctx = buildContext(descriptor, stdio, signal, sandboxAPI);

            const mod = descriptor.module!;
            
            let baseExtensions = mod.config.extensions || {};
            if (ports?.["@webrun/deno/webrtc"] && baseExtensions["@webrun/deno/webrtc"]) {
                baseExtensions = {
                    ...baseExtensions,
                    "@webrun/deno/webrtc": {
                        ...baseExtensions["@webrun/deno/webrtc"] as any,
                        udpPort: ports["@webrun/deno/webrtc"],
                    }
                };
            }

            const resolved = await resolveExtensions(baseExtensions);

            const runUserModule = makeRunUserModule(descriptor);

            const cascade = buildCascade(
                resolved,
                runUserModule,
            );

            try {
                await cascade(ctx);
                sandboxAPI.exit(0);
            } catch (err: unknown) {
                if (err instanceof WebrunExitError) {
                    return;
                }
                const stack = err instanceof Error ? (err.stack || err.message) : String(err);
                console.error("Uncaught Error:", rewriteForHumans(stack));
                sandboxAPI.exit(1);
            }
        },
    };
}
