import { executeServePayload } from "./serve.ts";
import { printExecutionError, printFatalError } from "./log.ts";
import { SandboxContextPayload, GuestRuntime, adaptGlobalRuntime } from "./types.ts";
import { createResilientStdinStream } from "./workarounds/deno/stdin.ts";
import { runTestSuite } from "./test_harness.ts";
import type { EnvironmentAdapter, AdapterStorage } from "./adapter.ts";
import { createCliAdapter } from "./adapters/cli.ts";

// =========================================================
// GUEST: Sandbox runtime setup and user code execution
// =========================================================
//
// The trampoline is environment-agnostic. All platform-specific
// operations are delegated to the EnvironmentAdapter (see adapter.ts).
// The CLI adapter (adapters/cli.ts) provides the Deno-specific
// implementation; a browser adapter would provide native Web APIs.



class WebrunExitError extends Error {
    code: number;
    constructor(code: number) {
        super(`exit(${code})`);
        this.name = "WebrunExitError";
        this.code = code;
    }
}

async function executeTestPayload(sys: GuestRuntime, payload: SandboxContextPayload & { action: "test" }, contextPayload: any) {
    const targetUrls = [payload.targetUrlHref, ...(payload.additionalTargetUrls || [])];
    const targetPaths = [payload.targetScriptPath, ...(payload.additionalTargetPaths || [])];

    // Collect exports grouped by source file, preserving declaration order.
    const bySource = new Map<string, { name: string; fn: Function }[]>();
    const seenNames = new Set<string>();

    for (let i = 0; i < targetUrls.length; i++) {
        const mod = await import(targetUrls[i]);
        const source = targetPaths[i];
        if (!bySource.has(source)) bySource.set(source, []);
        for (const [exportName, fn] of Object.entries(mod)) {
            if (exportName.startsWith("test") && typeof fn === "function") {
                const displayName = exportName.substring(4).trim() || exportName;
                if (seenNames.has(displayName)) {
                    console.warn(`[Webrun] Duplicate test name "${displayName}" — skipping duplicate registration.`);
                    continue;
                }
                seenNames.add(displayName);
                bySource.get(source)!.push({ name: displayName, fn: fn as Function });
            }
        }
    }

    if (seenNames.size === 0) {
        console.warn("[Webrun] No test exports found. Expected functions starting with 'test'.");
        throw new WebrunExitError(0);
    }

    // console.log uses Deno.core.print() which is synchronous and unbuffered —
    // it goes directly through the OS write() syscall without Tokio queuing.
    const print = (line: string) => console.log(line);

    // Initialize the webrun/ctx singleton before user modules load.
    const { set } = await import("webrun/ctx");
    set(contextPayload);

    let totalFailed = 0;

    // When a filter is active, check if ANY test across ALL sources has a
    // top-level name match. If so, skip entire source files that have no
    // matching tests — prevents the harness passthrough from running
    // unrelated tests in non-matching sources.
    const allTests = [...bySource.values()].flat();
    const hasGlobalTopMatch = payload.filterPattern
        ? allTests.some(({ name }) => name.includes(payload.filterPattern!))
        : false;

    for (const [source, tests] of bySource) {
        if (hasGlobalTopMatch && payload.filterPattern) {
            const hasLocalMatch = tests.some(({ name }) => name.includes(payload.filterPattern!));
            if (!hasLocalMatch) continue;
        }

        const summary = await runTestSuite(
            tests as any,
            contextPayload,
            source,
            print,
            payload.filterPattern,
        );
        totalFailed += summary.failed;
    }

    sys.exit(totalFailed > 0 ? 1 : 0);
}


async function executeRunPayload(sys: GuestRuntime, payload: SandboxContextPayload & { action: "run" | "eval" | "check-only" }, contextPayload: any) {
    if (payload.action === "check-only") {
        await import(payload.targetUrlHref);
        sys.exit(0);
        return;
    }

    // Initialize the webrun/ctx singleton before user modules load.
    const { set } = await import("webrun/ctx");
    set(contextPayload);

    if (payload.action === "eval") {
        const mod = await import(payload.targetUrlHref);
        if (mod.default && typeof mod.default === "function") {
            try {
                await mod.default(contextPayload);
            } catch (e: any) {
                if (e instanceof WebrunExitError) {
                    sys.exit(e.code);
                    return;
                }
                throw e;
            }
        }
        sys.exit(0);
        return;
    }

    const mod = await import(payload.targetUrlHref);
    if (mod.default && typeof mod.default === "function") {
        try {
            await mod.default(contextPayload);
        } catch (e: any) {
            if (e instanceof WebrunExitError) {
                sys.exit(e.code);
                return;
            }
            throw e;
        }
    }
    sys.exit(0);
}



const rewritePermissionError = (msg: string): string => {
    if (!msg) return msg;
    if (msg.includes("run again with the --allow-")) {
        return msg.replace(/, run again with the --allow-[a-z-]+ flag/g, "")
            + ".\n  Hint: Update the 'permissions' object in your webrun.json to allow this operation.";
    }
    return msg;
};

function setupSandboxErrorHandlers(sys: GuestRuntime) {
    globalThis.addEventListener('unhandledrejection', (e: any) => {
        if (e.reason?.name === "WebrunExitError") {
            e.preventDefault();
            sys.exit(e.reason.code);
            return;
        }
        if (e.reason?.name === "AbortError") {
            e.preventDefault();
            return;
        }
        e.preventDefault();
        printExecutionError(rewritePermissionError(e.reason?.message || String(e.reason)));
        if (e.reason?.stack) console.error(e.reason.stack);
        sys.exit(1);
    });

    globalThis.addEventListener('error', (e: any) => {
        if (e.error?.name === "WebrunExitError") {
            e.preventDefault();
            sys.exit(e.error.code);
            return;
        }
        if (e.error?.name === "AbortError") {
            e.preventDefault();
            return;
        }
        e.preventDefault();
        printExecutionError(rewritePermissionError(e.error?.message || String(e.error)));
        if (e.error?.stack) console.error(e.error.stack);
        sys.exit(1);
    });
}

/**
 * Polled RSS monitor that catches memory growth beyond V8's heap limit.
 * Uses sys.memoryUsage (captured before global scrub) to check RSS,
 * which includes WASM linear memory, off-heap buffers, and mapped files
 * that --max-old-space-size doesn't cover.
 */
function setupMemoryMonitor(sys: GuestRuntime, memoryMB: number) {
    const MAX_RSS_BYTES = memoryMB * 1024 * 1024;
    const getMemoryUsage = sys.memoryUsage;
    setInterval(() => {
        const usage = getMemoryUsage();
        if (usage.rss > MAX_RSS_BYTES) {
            const currentMB = (usage.rss / 1024 / 1024).toFixed(2);
            printFatalError("Memory limit exceeded!", `Current: ${currentMB}MB / Allowed: ${memoryMB}MB`);
            sys.exit(137);
        }
    }, 500);
}


/**
 * Constructs the ctx object passed to guest user code.
 * Combines adapter-provided primitives with shared logic.
 */
async function buildContextPayload(
    sys: GuestRuntime,
    payload: SandboxContextPayload,
    argsPayload: string[],
    flags: Record<string, any>,
    storage: AdapterStorage,
    bindings: Record<string, { fetch: typeof fetch }>,
    spawnChild: (spawnArgs: string[], options?: any) => Promise<any>,
    nativeFetch: typeof fetch,
    signal: AbortSignal,
    tty: {
        isTerminal: boolean;
        setRaw: ((raw: boolean, opts?: { cbreak: boolean }) => void) | null;
        consoleSize: (() => { columns: number; rows: number }) | null;
        rawModeState: { enabled: boolean };
    },
): Promise<any> {
    const { manager: storageManager, FileSystemDirectoryHandle, resolvePath } = storage;

    const ctx: any = {
        args: argsPayload,
        flags: flags,
        env: payload.finalEnvVars,
        command: payload.targetScriptPath,
        argv: [sys.execPath(), ...(payload.sandboxArgs || [])],
        dir: await storageManager.getDirectory(),
        persisted: !payload.fallbackToTemp,
        bindings,
        __internalRootUrl: `file://${payload.storageRoot}/`,
        __nativeFetch: nativeFetch,
        __resolvePath: resolvePath,
        __spawnChild: spawnChild,
        stdin: createResilientStdinStream(sys.stdin),
        stdout: sys.stdout?.writable || null,
        stderr: sys.stderr?.writable || null,
        signal,
        exit: (code: number = 0) => {
            setTimeout(() => sys.exit(code), 10);
            throw new WebrunExitError(code);
        },
        makeTempDir: async () => {
            if (!payload.runnerTmp) throw new Error("Sandbox initialization error: missing runnerTmp boundary");
            const uuid = crypto.randomUUID();
            const tempDirPath = payload.runnerTmp + "/" + uuid;
            sys.mkdirSync(tempDirPath, { recursive: true });
            return new FileSystemDirectoryHandle(tempDirPath, uuid);
        },
        upgradeWebSocket: payload.action === "serve"
            ? (req: Request) => sys.upgradeWebSocket(req)
            : () => { throw new Error("upgradeWebSocket is only available in --serve mode."); },
    };

    // TTY (CLI only)
    if (tty.isTerminal) {
        ctx.tty = {
            async setRawMode(raw: boolean): Promise<void> {
                tty.setRaw!(raw, { cbreak: true });
                tty.rawModeState.enabled = raw;
            },
            get isRaw(): boolean { return tty.rawModeState.enabled; },
            get columns(): number { return tty.consoleSize!().columns; },
            get rows(): number { return tty.consoleSize!().rows; },
        };
    }

    return ctx;
}

// =========================================================
// MAIN TRAMPOLINE — environment-agnostic
// =========================================================

export async function executeInsideSandbox(payload: SandboxContextPayload): Promise<void>;
export async function executeInsideSandbox(sys: GuestRuntime, payload: SandboxContextPayload): Promise<void>;
export async function executeInsideSandbox(sysOrPayload: GuestRuntime | SandboxContextPayload, maybePayload?: SandboxContextPayload) {
    const sys: GuestRuntime = ('injectedArgsObj' in sysOrPayload) ? adaptGlobalRuntime() : sysOrPayload as GuestRuntime;
    const payload: SandboxContextPayload = ('injectedArgsObj' in sysOrPayload) ? sysOrPayload as SandboxContextPayload : maybePayload!;
    const rawArgs = payload.injectedArgsObj;
    const argsPayload: string[] = [...rawArgs["--"]];
    const flags = { ...rawArgs };
    delete flags["--"];

    // Create the environment adapter.
    const adapter = createCliAdapter(sys);

    // 1. Capture fetch before any globals are modified.
    const nativeFetch = adapter.captureFetch();

    // 2. Set up OPFS storage (for navigator.storage).
    const opfsStorage = adapter.createStorage(payload, "opfs");

    // 3. Set up navigator.storage (shared).
    if (!(globalThis as any).navigator) {
        (globalThis as any).navigator = {};
    }
    (globalThis as any).navigator.storage = opfsStorage.manager;

    // 4. Set up ctx.dir storage (may differ from OPFS root).
    const ctxStorage = adapter.createStorage(payload, "ctx");

    // 4. Set up performance polyfills (adapter-specific).
    adapter.setupPerformanceMemory(payload.memoryMB);

    // 5. Patch Worker constructor (adapter-specific).
    adapter.patchWorkerConstructor(payload.memoryMB);

    // 6. Set up error handlers (shared — uses web APIs).
    setupSandboxErrorHandlers(sys);

    // 7. Set up memory monitor if configured.
    // Checks RSS (not just V8 heap) to catch all memory growth.
    if (payload.memoryMB) {
        setupMemoryMonitor(sys, payload.memoryMB);
    }


    // 8. Bootstrap WebRTC if enabled (adapter-specific, must be before scrub).
    await adapter.bootstrapWebRTC(payload);

    // 9. Build binding clients (adapter-specific).
    const bindings = adapter.buildBindingClients(payload);

    // 10. Build spawn child (adapter-specific).
    const spawnChild = adapter.buildSpawnChild(payload);

    // 11. Capture TTY state before globals are wiped.
    let stdinIsTerminal = false;
    try { stdinIsTerminal = sys.stdin.isTerminal(); } catch (_) {}
    const rawModeState = { enabled: false };
    const tty = {
        isTerminal: stdinIsTerminal,
        setRaw: stdinIsTerminal
            ? (raw: boolean, opts?: { cbreak: boolean }) => sys.stdin.setRaw(raw, opts)
            : null,
        consoleSize: stdinIsTerminal
            ? () => sys.consoleSize()
            : null,
        rawModeState,
    };

    // 12. Scrub globals (adapter-specific, irrevocable).
    adapter.scrubGlobals();

    // 13. Set up signal bridge (adapter-specific, after scrub).
    const { signal } = adapter.setupSignalBridge();

    try {
        const contextPayload = await buildContextPayload(
            sys, payload, argsPayload, flags,
            ctxStorage, bindings, spawnChild, nativeFetch, signal, tty,
        );

        try {
            if (payload.action === "test") {
                await executeTestPayload(sys, payload, contextPayload);
            } else if (payload.action === "serve") {
                await executeServePayload(sys, payload, contextPayload);
            } else {
                await executeRunPayload(sys, payload, contextPayload);
            }
        } finally {
            // Restore cooked mode if raw mode was ever enabled.
            if (rawModeState.enabled) {
                try { tty.setRaw!(false); } catch (_) {}
            }
        }
    } catch (err: any) {
        if (err instanceof WebrunExitError || err?.name === "WebrunExitError") {
            sys.exit(err.code);
            return;
        }
        printExecutionError(rewritePermissionError(err?.message || String(err)));
        await new Promise(r => setTimeout(r, 10));
        sys.exit(1);
    }
}
