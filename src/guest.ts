import { executeServePayload } from "./serve.ts";
import { resolveWebrunEntryUrl } from "./sys.ts";
import { printExecutionError, printFatalError } from "./log.ts";
import { SandboxContextPayload, GuestRuntime, adaptGlobalRuntime } from "./types.ts";
import { createStorageManager } from "./fs.ts";
import { createResilientStdinStream } from "./workarounds/deno/stdin.ts";
import { runTestSuite } from "./test_harness.ts";
import { parseCommandInvocation } from "./config.ts";


// =========================================================
// GUEST: Sandbox runtime setup and user code execution
// =========================================================



class WebrunExitError extends Error {
    code: number;
    constructor(code: number) {
        super(`exit(${code})`);
        this.name = "WebrunExitError";
        this.code = code;
    }
}

/**
 * Translation layer: bridges the legacy `testCapabilities` permission to the
 * test-context object expected by un-migrated test files.
 *
 * Lifespan: remove once all tests under tests/ no longer reference `t.testsys`,
 * `t.WORKER_BIN`, or `t.IS_REPACKED_TEST`. Track progress in:
 * https://github.com/substrateos/webrun/issues/TBD
 *
 * DO NOT extend this function. New test helpers belong in webrun/ctx or the
 * public TestContext interface, not here.
 */
function injectLegacyTestCapabilities(
    t: any,
    sys: GuestRuntime,
    contextPayload: any,
    payload: SandboxContextPayload,
): void {
    t.testsys = {
        env: sys.env,
        Command: sys.Command,
        execPath: sys.execPath,
        nativeFetch: contextPayload.__nativeFetch,
        makeTempDirSync: sys.makeTempDirSync,
        realPathSync: sys.realPathSync,
        readTextFileSync: sys.readTextFileSync,
        readFileSync: sys.readFileSync,
        readDirSync: sys.readDirSync,
        writeTextFileSync: sys.writeTextFileSync,
        writeFileSync: sys.writeFileSync,
        mkdirSync: sys.mkdirSync,
        symlinkSync: sys.symlinkSync,
        removeSync: sys.removeSync,
        statSync: sys.statSync,
        listen: sys.listen,
        serve: sys.serve,
        getFreePort: () => {
            const l = sys.listen({ port: 0, hostname: "127.0.0.1" });
            const port = l.addr.port;
            l.close();
            return port;
        },
    };
    t.WORKER_BIN = payload.webrunBin;
    t.IS_REPACKED_TEST = payload.isRepackedTest;
}

async function executeTestPayload(sys: GuestRuntime, payload: SandboxContextPayload, contextPayload: any) {
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

    const webrunCtxMod = await import("webrun/ctx").catch((err) => {
        console.warn(`[Webrun] webrun/ctx failed to load — ctx will be unavailable: ${err?.message}`);
        return null;
    });
    if (webrunCtxMod?.set) webrunCtxMod.set(contextPayload);

    // console.log uses Deno.core.print() which is synchronous and unbuffered —
    // it goes directly through the OS write() syscall without Tokio queuing.
    // Deno.stdout.writable.write() is async and may batch; console.log is the
    // correct choice for real-time test output.
    const print = (line: string) => console.log(line);

    let totalFailed = 0;
    for (const [source, exports] of bySource) {
        const tests = exports.map(({ name, fn }) => ({
            name,
            fn: async (t: any, ctx: any) => {
                if (payload.testCapabilities) injectLegacyTestCapabilities(t, sys, contextPayload, payload);
                await fn(t, ctx);
            },
        }));
        // When filtering across multiple source files, skip sources that have
        // no matching test names — prevents unrelated sources from running
        // through the sub-step passthrough path.
        if (payload.filterPattern && bySource.size > 1) {
            const hasMatch = tests.some(({ name }) => name.includes(payload.filterPattern!));
            if (!hasMatch) continue;
        }
        const { failed } = await runTestSuite(tests, contextPayload, source, print, payload.filterPattern);
        totalFailed += failed;
    }

    sys.exit(totalFailed > 0 ? 1 : 0);
}


async function executeRunPayload(sys: GuestRuntime, payload: SandboxContextPayload, contextPayload: any) {
    contextPayload.command = payload.targetScriptPath;

    const webrunCtxMod = await import("webrun/ctx").catch((err) => {
        console.warn(`[Webrun] webrun/ctx failed to load — ctx will be unavailable: ${err?.message}`);
        return null;
    });
    if (webrunCtxMod && webrunCtxMod.set) {
        webrunCtxMod.set(contextPayload);
    }

    const mod = await import(payload.targetUrlHref);
    const mainFn = typeof mod.default === 'function' ? mod.default : (mod.default && typeof mod.default.main === 'function' ? mod.default.main : null);
    if (mainFn) {
        try {
            await mainFn(contextPayload);
        } catch (e) {
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

function setupSandboxGlobals(sys: GuestRuntime, payload: SandboxContextPayload) {
    const { manager: opfsManager } = createStorageManager(sys, payload.opfsRoot, true);

    if (!(globalThis as any).navigator) {
        (globalThis as any).navigator = {};
    }
    (globalThis as any).navigator.storage = opfsManager;

    if (!(globalThis as any).performance) {
        (globalThis as any).performance = {};
    }

    Object.defineProperty((globalThis as any).performance, 'memory', {
        get: () => {
            const usage = sys.memoryUsage();
            return {
                jsHeapSizeLimit: payload.memoryMB ? payload.memoryMB * 1024 * 1024 : 4294967296,
                totalJSHeapSize: usage.heapTotal || usage.rss,
                usedJSHeapSize: usage.heapUsed || usage.rss
            };
        },
        configurable: true
    });

    (globalThis as any).performance.measureMemory = async () => {
        const usage = sys.memoryUsage();
        const bytes = usage.heapUsed || usage.rss;
        return {
            bytes,
            breakdown: [{
                bytes,
                attribution: [],
                types: ["Window"]
            }]
        };
    };

    const OriginalWorker = (globalThis as any).Worker;
    if (OriginalWorker) {
        (globalThis as any).Worker = class SandboxWorker extends OriginalWorker {
            constructor(specifier: string | URL, options?: any) {
                const finalOptions = {
                    ...options,
                    type: "module",
                    deno: { permissions: "inherit" }
                };

                const targetUrl = typeof specifier === 'string' ? specifier : specifier.href;
                const injection = `
                    if (!self.performance) self.performance = {};
                    const _memoryUsage = self.Deno.memoryUsage.bind(self.Deno);
                    Object.defineProperty(self.performance, 'memory', {
                        get: () => {
                            const usage = _memoryUsage();
                            return {
                                jsHeapSizeLimit: ${payload.memoryMB ? payload.memoryMB * 1024 * 1024 : 4294967296},
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

                // Allow fallback if Deno constructor signature changes
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

    setupSandboxErrorHandlers(sys);

    if (payload.memoryMB) {
        setupMemoryMonitor(sys, payload.memoryMB);
    }
}

function setupFetchProxy(payload: SandboxContextPayload) {
    const originalFetch = globalThis.fetch;
    const moduleWorkers: Record<string, any> = {};
    const muxPort = payload.muxPort;
    const tokenMap = payload.tokenMap || {};

    // Set up module binding workers (same-process postMessage, no HTTP surface)
    for (const [name, b] of Object.entries(payload.bindingsMap || {})) {
        if (b.type === 'module') {
            const workerUrl = new URL(b.path as string, `file://${payload.storageRoot}/`).href;
            const w = new (globalThis as any).Worker(
                `data:application/javascript,import mod from "${workerUrl}"; self.onmessage = async (e) => { const { id, req } = e.data; try { const r = await (mod.default ? mod.default.fetch : mod.fetch)(new Request(req.url, req)); const buf = await r.arrayBuffer(); const headers = {}; for (const [k,v] of r.headers) headers[k]=v; self.postMessage({ id, status: r.status, headers, body: buf }, [buf]); } catch (err) { self.postMessage({ id, error: err.message }); } };`,
                { type: "module", deno: { permissions: "inherit" } }
            );
            moduleWorkers[name] = w;
        }
    }

    let fetchMsgId = 0;
    const workerResolvers: Record<number, any> = {};
    for (const w of Object.values(moduleWorkers)) {
        w.onmessage = (e: any) => {
            const res = workerResolvers[e.data.id];
            if (res) {
                if (e.data.error) {
                    printExecutionError(e.data.error);
                    res.resolve(new Response(e.data.error, { status: 500 }));
                } else {
                    res.resolve(new Response(e.data.body, { status: e.data.status, headers: e.data.headers }));
                }
                delete workerResolvers[e.data.id];
            }
        };
    }

    globalThis.fetch = async function (resource: any, init?: any) {
        if (!resource) throw new TypeError("Failed to fetch: Request cannot be constructed from undefined");
        const urlReq = typeof resource === 'string' ? resource : resource.url;
        const urlObj = new URL(urlReq);
        if (urlObj.protocol === 'webrun:') {
            const name = urlObj.hostname;

            // Module binding → dispatch via postMessage worker
            if (moduleWorkers[name]) {
                const w = moduleWorkers[name];
                const id = ++fetchMsgId;

                const bodyPromise = (async () => {
                    const finalReq = new Request(resource, init);
                    return {
                        url: finalReq.url,
                        method: finalReq.method,
                        headers: Object.fromEntries(finalReq.headers.entries()),
                        body: finalReq.body ? await finalReq.clone().arrayBuffer() : undefined
                    };
                })();

                return new Promise((resolve, reject) => {
                    workerResolvers[id] = { resolve, reject };
                    bodyPromise.then(reqObj => {
                        w.postMessage({ id, req: reqObj }, reqObj.body ? [reqObj.body] : undefined);
                    }).catch(reject);
                });
            }

            // Process binding → route through mux proxy with Bearer token
            const token = tokenMap[name];
            if (!token || !muxPort) {
                throw new TypeError(`Failed to fetch: No binding mapped to ${urlObj.href}`);
            }

            const proxyUrl = `http://127.0.0.1:${muxPort}${urlObj.pathname}${urlObj.search}`;
            const headers = new Headers(init?.headers || (resource instanceof Request ? resource.headers : undefined));
            headers.set("Authorization", `Bearer ${token}`);

            return originalFetch(proxyUrl, {
                method: init?.method || (resource instanceof Request ? resource.method : "GET"),
                headers,
                body: init?.body || (resource instanceof Request ? resource.body : undefined),
            });
        }

        return originalFetch(resource, init);
    };
}

/** Irrevocably deletes all non-web globals (Deno, Node shims). */
function scrubNonWebGlobals(): void {
    delete (globalThis as any).Deno;
    delete (globalThis as any).process;
    delete (globalThis as any).Buffer;
    delete (globalThis as any).setImmediate;
    delete (globalThis as any).clearImmediate;
    delete (globalThis as any).global;
}

/**
 * Creates an AbortController that bridges OS signals to the web-standard
 * AbortSignal exposed via ctx.signal. Lazy-attaches listeners on first
 * addEventListener call to avoid binding signals the guest never uses.
 */
function setupSignalBridge(sys: GuestRuntime): { signal: AbortSignal } {
    const ac = new AbortController();
    const boundSignals = new Set<string>();

    const SIGNAL_EXIT_CODES: Record<string, number> = {
        "SIGHUP": 129, "SIGINT": 130, "SIGTERM": 143,
    };

    const tryAttachListener = (sig: string) => {
        if (boundSignals.has(sig)) return;
        boundSignals.add(sig);

        if (["SIGINT", "SIGTERM", "SIGHUP"].includes(sig)) {
            try {
                sys.addSignalListener(sig as any, () => {
                    const event = new Event(sig, { cancelable: true });
                    ac.signal.dispatchEvent(event);
                    if (!ac.signal.aborted) ac.abort(sig);
                    if (!event.defaultPrevented) {
                        setTimeout(() => sys.exit(SIGNAL_EXIT_CODES[sig]), 10);
                    }
                });
            } catch (_) { }
        } else if (["SIGUSR1", "SIGUSR2"].includes(sig)) {
            try {
                sys.addSignalListener(sig as any, () => {
                    ac.signal.dispatchEvent(new Event(sig));
                });
            } catch (_) { }
        }
    };

    const originalAddEventListener = ac.signal.addEventListener;
    ac.signal.addEventListener = function (type: string, listener: any, options?: boolean | AddEventListenerOptions) {
        tryAttachListener(type);
        return originalAddEventListener.call(this, type, listener, options);
    };

    return { signal: ac.signal };
}

/**
 * Primitives captured before the global wipe that are needed
 * to construct the guest context object.
 */
interface GuestCaptures {
    nativeFetch: typeof globalThis.fetch;
    OriginalWorker: any;
    storageManager: any;
    FileSystemDirectoryHandle: any;
    /** Resolves a FileSystemHandle to its absolute path. */
    resolvePath: (h: any) => string | undefined;
    stdinIsTerminal: boolean;
    stdinSetRaw: ((raw: boolean, opts?: { cbreak: boolean }) => void) | null;
    getConsoleSize: (() => { columns: number; rows: number }) | null;
    rawModeState: { enabled: boolean };
}


/**
 * Constructs the ctx object passed to guest user code.
 * Performs minimal I/O (storage directory resolution, temp dir creation)
 * but does not mutate globals or attach signal listeners.
 */
async function buildContextPayload(
    sys: GuestRuntime,
    payload: SandboxContextPayload,
    argsPayload: string[],
    flags: Record<string, any>,
    captures: GuestCaptures,
    signal: AbortSignal,
): Promise<any> {
    const { storageManager, FileSystemDirectoryHandle, nativeFetch, OriginalWorker,
            stdinIsTerminal, stdinSetRaw, getConsoleSize, rawModeState } = captures;
    return {
        args: argsPayload,
        flags: flags,
        env: payload.finalEnvVars,
        command: payload.targetScriptPath,
        argv: [payload.webrunBin, ...(payload.sandboxArgs || [])],
        dir: await storageManager.getDirectory(),
        persisted: !payload.fallbackToTemp,
        bindings: Object.fromEntries(Object.entries(payload.bindingsMap || {}).map(([k, _v]: any) => [k, 'webrun://' + k])),
        __internalRootUrl: `file://${payload.storageRoot}/`,
        __nativeFetch: nativeFetch,
        __resolvePath: captures.resolvePath,
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
        tty: stdinIsTerminal ? {
            async setRawMode(raw: boolean): Promise<void> {
                stdinSetRaw!(raw, { cbreak: true });
                rawModeState.enabled = raw;
            },
            get isRaw(): boolean { return rawModeState.enabled; },
            get columns(): number { return getConsoleSize!().columns; },
            get rows(): number { return getConsoleSize!().rows; },
        } : undefined,
    };
}

// =========================================================
// SPAWN ORCHESTRATOR
// =========================================================
//
// Handles ctx.webrun() spawn requests from post-scrub user code via
// a MessageChannel. Runs on port1 (the orchestrator side). User code
// posts requests through port2.
//
// This function captures Worker, parseCommandInvocation, and the
// entry URL BEFORE the global scrub — these are the "retained
// authorities" that user code cannot access directly.

function createSpawnChild(
    CapturedWorker: any,
    entryUrl: string,
    parentPayload: SandboxContextPayload,
    sys: any,
): (spawnArgs: string[], options?: any) => Promise<any> {
    return (spawnArgs: string[], options: any = {}): Promise<any> => {
        return new Promise((resolve) => {
        let blobUrl: string | undefined;
        try {
        // Build child payload from the parent's payload.
        const childPayload: any = { ...parentPayload };
        delete childPayload.__udpPort;
        childPayload.__internalRootUrl = `file://${parentPayload.storageRoot}/`;
        childPayload.sandboxArgs = [...spawnArgs];
        if (options?.memoryMB) childPayload.memoryMB = options.memoryMB;
        if (options?.env) childPayload.finalEnvVars = options.env;
        if (options?.cwdPath) {
            childPayload.storageRoot = options.cwdPath;
            childPayload.fallbackToTemp = false;
        }

        // Parse the command invocation (retained authority — not
        // available to post-scrub code).
        const invocation = parseCommandInvocation(
            sys,
            childPayload.sandboxArgs,
            childPayload.config || {},
            childPayload.configDir || "",
        );
        childPayload.injectedArgsObj = invocation.injectedArgsObj;
        childPayload.action = invocation.action;
        if (invocation.filterPattern) childPayload.filterPattern = invocation.filterPattern;
        if (invocation.action === "serve") childPayload.serveInterfaces = invocation.serveInterfaces;
        if (invocation.action === "eval") {
            childPayload.targetScriptPath = "[eval]";
            childPayload.targetUrlHref = "data:application/typescript;charset=utf-8," + encodeURIComponent(invocation.evalCode!);
            childPayload.evalCode = invocation.evalCode;
        } else {
            childPayload.targetScriptPath = invocation.targetScriptPath || "";
            childPayload.evalCode = undefined;
            const rootUrl = childPayload.__internalRootUrl;
            const resolveUrl = (p: string) => {
                try { return new URL(p).href; }
                catch { return new URL(p, rootUrl).href; }
            };
            childPayload.targetUrlHref = resolveUrl(childPayload.targetScriptPath);
            if (invocation.additionalTargets?.length) {
                childPayload.additionalTargetPaths = invocation.additionalTargets;
                childPayload.additionalTargetUrls = invocation.additionalTargets.map(resolveUrl);
            }
        }

        // Create the child Worker (retained authority — CapturedWorker
        // was saved before the global scrub deleted globalThis.Worker).
        const workerCode = `
            import { executeInsideSandbox } from "${entryUrl}";
            self.onmessage = async (e) => {
                if (e.data.type === "spawn") {
                    const sys = { ...globalThis.Deno, exit: (code) => { self.postMessage({ type: "exit", code }); self.close(); } };
                    console.log = (...a) => { self.postMessage({ type: "stdout", chunk: a.map(String).join(" ") }); };
                    console.error = (...a) => { self.postMessage({ type: "stderr", chunk: a.map(String).join(" ") }); };
                    try {
                        await executeInsideSandbox(sys, e.data.payload);
                    } catch (err) {
                        console.error(err.message || String(err));
                        sys.exit(1);
                    }
                }
            };
        `;

                blobUrl = URL.createObjectURL(new Blob([workerCode], { type: "application/javascript" }));
                const worker = new CapturedWorker(blobUrl, { type: "module", name: "webrun-sub-worker", deno: { permissions: "inherit" } });

                let stdoutBuf = "";
                let stderrBuf = "";
                let settled = false;

                function finish(exitCode: number, extraStderr?: string) {
                    if (settled) return;
                    settled = true;
                    URL.revokeObjectURL(blobUrl!);
                    if (extraStderr) stderrBuf += extraStderr;
                    resolve({ exitCode, stdout: stdoutBuf, stderr: stderrBuf });
                }

                worker.onmessage = (we: MessageEvent) => {
                    if (we.data.type === "stdout") {
                        stdoutBuf += we.data.chunk + "\n";
                        if (options?.onStdout) options.onStdout(we.data.chunk);
                        if (options?.stdout === "inherit") console.log(we.data.chunk);
                    } else if (we.data.type === "stderr") {
                        stderrBuf += we.data.chunk + "\n";
                        if (options?.onStderr) options.onStderr(we.data.chunk);
                        if (options?.stderr === "inherit") console.error(we.data.chunk);
                    } else if (we.data.type === "exit") {
                        worker.terminate();
                        finish(we.data.code);
                    }
                };
                worker.onerror = (err: any) => {
                    worker.terminate();
                    finish(1, "\n" + (err.message || String(err)));
                };

                // Handle abort.
                if (options.abort) {
                    options.abort.then(() => {
                        worker.terminate();
                        finish(143);
                    });
                }

                // Handle timeout.
                if (options.timeoutMillis) {
                    setTimeout(() => {
                        worker.terminate();
                        finish(143, "\nTimeout limit reached");
                    }, options.timeoutMillis);
                }

                // Start the child.
                worker.postMessage({ type: "spawn", payload: childPayload });
        } catch (err: any) {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            resolve({ exitCode: 1, stdout: "", stderr: err.message || String(err) });
        }
        });
    };
}

export async function executeInsideSandbox(payload: SandboxContextPayload): Promise<void>;
export async function executeInsideSandbox(sys: GuestRuntime, payload: SandboxContextPayload): Promise<void>;
export async function executeInsideSandbox(sysOrPayload: GuestRuntime | SandboxContextPayload, maybePayload?: SandboxContextPayload) {
    const sys: GuestRuntime = ('injectedArgsObj' in sysOrPayload) ? adaptGlobalRuntime() : sysOrPayload as GuestRuntime;
    const payload: SandboxContextPayload = ('injectedArgsObj' in sysOrPayload) ? sysOrPayload as SandboxContextPayload : maybePayload!;
    const rawArgs = payload.injectedArgsObj;
    const argsPayload: string[] = [...rawArgs["--"]];
    const flags = { ...rawArgs };
    delete flags["--"];

    const { manager: storageManager, FileSystemDirectoryHandle, resolvePath } = createStorageManager(sys, payload.storageRoot, payload.fallbackToTemp);

    // Capture primitives before the global wipe. These are bundled into
    // GuestCaptures and threaded to buildContextPayload.
    let stdinIsTerminal = false;
    try { stdinIsTerminal = sys.stdin.isTerminal(); } catch (_) {}
    const rawModeState = { enabled: false };

    const captures: GuestCaptures = {
        nativeFetch: globalThis.fetch,
        OriginalWorker: (globalThis as any).Worker,
        storageManager,
        FileSystemDirectoryHandle,
        resolvePath,
        stdinIsTerminal,
        stdinSetRaw: stdinIsTerminal
            ? (raw: boolean, opts?: { cbreak: boolean }) => sys.stdin.setRaw(raw, opts)
            : null,
        getConsoleSize: stdinIsTerminal
            ? () => sys.consoleSize()
            : null,
        rawModeState,
    };

    setupSandboxGlobals(sys, payload);
    setupFetchProxy(payload);

    // WebRTC bootstrap: if the host passed a UDP relay port, wire it up
    // before deleting Deno globals and before untrusted code executes.
    // All Node globals that werift needs are captured here and injected into
    // the bundle's module-scoped shims — they never leak onto globalThis.
    const hasWebRTC = !!(payload as any).__udpPort;


    if (hasWebRTC) {
        const savedBuffer = (globalThis as any).Buffer;
        const savedSetImmediate = (globalThis as any).setImmediate;
        const savedClearImmediate = (globalThis as any).clearImmediate;
        const savedProcess = (globalThis as any).process;
        const savedNetworkInterfaces = sys.networkInterfaces;


        const { bootstrapWebRTC } = await import("./internal/webrtc_polyfill.ts");
        bootstrapWebRTC({
            udpPort: (payload as any).__udpPort,
            Buffer: savedBuffer,
            setImmediate: savedSetImmediate,
            clearImmediate: savedClearImmediate,
            process: savedProcess,
            networkInterfaces: savedNetworkInterfaces,
        });

    }

    // --- Spawn orchestrator ---
    // Capture everything the orchestrator needs BEFORE the global scrub.
    // After scrubNonWebGlobals(), Deno, Worker, and other platform APIs
    // are gone from globalThis. The closure retains references to
    // create child Workers on behalf of post-scrub user code.
    const CapturedWorker = captures.OriginalWorker;
    const capturedEntryUrl = resolveWebrunEntryUrl(import.meta.url);

    const spawnChild = createSpawnChild(CapturedWorker, capturedEntryUrl, payload, sys);

    scrubNonWebGlobals();

    try {
        const { signal } = setupSignalBridge(sys);

        const contextPayload = await buildContextPayload(
            sys, payload, argsPayload, flags, captures, signal,
        );

        // Pass the spawn function into the context so ctx.webrun()
        // can invoke it directly.
        contextPayload.__spawnChild = spawnChild;

        try {
            if (payload.action === "test") {
                await executeTestPayload(sys, payload, contextPayload);
            } else if (payload.action === "serve") {
                await executeServePayload(sys, payload, contextPayload);
            } else {
                await executeRunPayload(sys, payload, contextPayload);
            }
        } finally {
            // Restore cooked mode if raw mode was ever enabled, regardless of
            // how the script exited (normal return, exception, ctx.exit()).
            if (captures.rawModeState.enabled) {
                try { captures.stdinSetRaw!(false); } catch (_) {}
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

