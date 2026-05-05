// =========================================================
// CLI ENVIRONMENT ADAPTER
// =========================================================
//
// Implements the EnvironmentAdapter interface for the Deno CLI runtime.
// All environment-specific operations that were formerly inline in
// guest.ts are now consolidated here.

import type { EnvironmentAdapter, AdapterStorage } from "../adapter.ts";
import type { SandboxContextPayload, GuestRuntime } from "../types.ts";
import { createStorageManager } from "../fs.ts";
import { BROWSER_USER_AGENT } from "../constants.ts";

/**
 * Creates a CLI adapter bound to the given GuestRuntime.
 *
 * The adapter captures Deno-specific globals (fetch, Worker, Buffer, etc.)
 * before they are scrubbed, and provides them to the trampoline through
 * the EnvironmentAdapter interface.
 */
export function createCliAdapter(sys: GuestRuntime): EnvironmentAdapter {
    // Pre-scrub captures. Set during captureFetch() and used throughout.
    let nativeFetch: typeof fetch;


    return {
        captureFetch(): typeof fetch {
            nativeFetch = globalThis.fetch;

            // Install a wrapper that injects a browser-like User-Agent
            // when the user hasn't explicitly set one.
            globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                const headers = new Headers(init?.headers);
                if (!headers.has("User-Agent")) {
                    headers.set("User-Agent", BROWSER_USER_AGENT);
                }
                return nativeFetch(input, { ...init, headers });
            };

            return nativeFetch;
        },

        createStorage(payload: SandboxContextPayload, mode: "opfs" | "ctx"): AdapterStorage {
            if (mode === "opfs") {
                const { manager, FileSystemDirectoryHandle, resolvePath } = createStorageManager(
                    sys, payload.opfsRoot, true,
                );
                return { manager, FileSystemDirectoryHandle, resolvePath };
            }
            const { manager, FileSystemDirectoryHandle, resolvePath } = createStorageManager(
                sys, payload.storageRoot, payload.fallbackToTemp,
            );
            return { manager, FileSystemDirectoryHandle, resolvePath };
        },

        setupPerformanceMemory(memoryMB?: number): void {
            if (!(globalThis as any).performance) {
                (globalThis as any).performance = {};
            }

            Object.defineProperty((globalThis as any).performance, 'memory', {
                get: () => {
                    const usage = sys.memoryUsage();
                    return {
                        jsHeapSizeLimit: memoryMB ? memoryMB * 1024 * 1024 : 4294967296,
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
                    breakdown: [{ bytes, attribution: [], types: ["Window"] }]
                };
            };
        },

        patchWorkerConstructor(memoryMB?: number): void {
            const OriginalWorker = (globalThis as any).Worker;
            if (!OriginalWorker) return;

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
        },

        async bootstrapWebRTC(payload: SandboxContextPayload): Promise<void> {
            const udpPort = (payload as any).__udpPort;
            if (!udpPort) return;

            const savedBuffer = (globalThis as any).Buffer;
            const savedSetImmediate = (globalThis as any).setImmediate;
            const savedClearImmediate = (globalThis as any).clearImmediate;
            const savedProcess = (globalThis as any).process;
            const savedNetworkInterfaces = sys.networkInterfaces;

            const { bootstrapWebRTC } = await import("../internal/webrtc_polyfill.ts");
            bootstrapWebRTC({
                udpPort,
                Buffer: savedBuffer,
                setImmediate: savedSetImmediate,
                clearImmediate: savedClearImmediate,
                process: savedProcess,
                networkInterfaces: savedNetworkInterfaces,
            });
        },

        buildBindingClients(payload: SandboxContextPayload): Record<string, { fetch: typeof fetch }> {
            const clients: Record<string, { fetch: typeof fetch }> = {};
            const muxPort = payload.muxPort;

            for (const [name, b] of Object.entries(payload.bindingsMap || {})) {
                const token = b.token;
                if (!token || !muxPort) continue;

                clients[name] = {
                    fetch: async (resource: any, init?: any) => {
                        const finalReq = normalizeBindingInput(resource, init);
                        const urlObj = new URL(finalReq.url);
                        const proxyUrl = `http://127.0.0.1:${muxPort}${urlObj.pathname}${urlObj.search}`;
                        const headers = new Headers(finalReq.headers);
                        headers.set("Authorization", `Bearer ${token}`);
                        return nativeFetch(proxyUrl, {
                            method: finalReq.method,
                            headers,
                            body: finalReq.body,
                        });
                    },
                };
            }

            return clients;
        },

        buildSpawnChild(payload: SandboxContextPayload): (spawnArgs: string[], options?: any) => Promise<any> {
            if (payload.muxPort && payload.spawnToken) {
                return createMuxSpawnChild(payload.muxPort, payload.spawnToken, nativeFetch);
            }
            return async () => ({ exitCode: 1, stdout: "", stderr: "spawn unavailable\n" });
        },

        scrubGlobals(): void {
            delete (globalThis as any).Deno;
            delete (globalThis as any).process;
            delete (globalThis as any).Buffer;
            delete (globalThis as any).setImmediate;
            delete (globalThis as any).clearImmediate;
            delete (globalThis as any).global;
        },

        setupSignalBridge(): { signal: AbortSignal } {
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
        },
    };
}

// ── Private helpers ──────────────────────────────────────────────

function normalizeBindingInput(resource: any, init?: any): Request {
    if (typeof resource === 'string' && !resource.includes('://')) {
        const path = resource.startsWith('/') ? resource : '/' + resource;
        return new Request(`http://binding${path}`, init);
    }
    return new Request(resource, init);
}

function createMuxSpawnChild(
    muxPort: number,
    spawnToken: string,
    originalFetch: typeof fetch,
): (spawnArgs: string[], options?: any) => Promise<any> {
    const muxBase = `http://127.0.0.1:${muxPort}`;
    const authHeaders = { "Authorization": `Bearer ${spawnToken}` };

    return async (spawnArgs: string[], options: any = {}): Promise<any> => {
        const forceAc = new AbortController();

        let resp: Response;
        try {
            resp = await originalFetch(`${muxBase}/spawn`, {
                method: "POST",
                headers: { ...authHeaders, "Content-Type": "application/json" },
                body: JSON.stringify({
                    args: spawnArgs,
                    options: {
                        cwdPath: options.cwdPath,
                        env: options.env,
                        memoryMB: options.memoryMB,
                        timeoutMillis: options.timeoutMillis,
                    },
                }),
                signal: forceAc.signal,
            });
        } catch (_) {
            return { exitCode: 143, stdout: "", stderr: "" };
        }

        const spawnId = resp.headers.get("X-Spawn-Id");

        let graceTimer: number | undefined;
        if (options.abort) {
            options.abort.then((reason: any) => {
                const sig = typeof reason === "string" ? reason : "SIGTERM";
                if (spawnId) {
                    originalFetch(`${muxBase}/signal?id=${spawnId}&sig=${sig}`, {
                        method: "POST",
                        headers: authHeaders,
                    }).catch(() => {});
                }
                graceTimer = setTimeout(() => forceAc.abort(), 2000);
            });
        }

        let stdout = "";
        let stderr = "";
        let exitCode = 1;

        const reader = resp.body!.getReader();
        const dec = new TextDecoder();
        let buffer = "";

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += dec.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop()!;

                for (const line of lines) {
                    if (!line) continue;
                    const msg = JSON.parse(line);
                    if (msg.t === "o") {
                        stdout += msg.c + "\n";
                        if (options.onStdout) options.onStdout(msg.c);
                    } else if (msg.t === "e") {
                        stderr += msg.c + "\n";
                        if (options.onStderr) options.onStderr(msg.c);
                    } else if (msg.t === "x") {
                        exitCode = msg.c;
                    }
                }
            }
        } catch (_) {
            if (exitCode === 1 && forceAc.signal.aborted) exitCode = 143;
        }

        if (graceTimer !== undefined) clearTimeout(graceTimer);
        return { exitCode, stdout, stderr };
    };
}
