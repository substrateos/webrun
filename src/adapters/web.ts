// =========================================================
// BROWSER ENVIRONMENT ADAPTER (STUB)
// =========================================================
//
// Implements the EnvironmentAdapter interface for browser execution.
// In the browser, the sandbox runs inside an iframe with native Web
// APIs — most adapter methods are no-ops or thin wrappers.
//
// This is a stub: it defines the correct shape and documents the
// intended behavior for each method. Actual browser hosting (iframe
// creation, postMessage IPC, payload injection) is not yet built.

import type { EnvironmentAdapter, AdapterStorage } from "../adapter.ts";
import type { SandboxContextPayload } from "../types.ts";

/**
 * Creates a browser adapter.
 *
 * In the browser, the sandbox runs inside an iframe. The host page
 * communicates with the sandbox via postMessage. Native Web APIs
 * (OPFS, WebRTC, performance.memory, Workers) are available without
 * polyfills.
 */
export function createWebAdapter(): EnvironmentAdapter {
    return {
        captureFetch(): typeof fetch {
            // In the browser, fetch is a native Web API that doesn't
            // get scrubbed. No capture needed.
            return globalThis.fetch;
        },

        createStorage(_payload: SandboxContextPayload, _mode: "opfs" | "ctx"): AdapterStorage {
            // Browser uses native OPFS via navigator.storage.
            // Both "opfs" and "ctx" modes use the same native storage
            // since there are no Deno file APIs to shim.
            return {
                manager: navigator.storage,
                FileSystemDirectoryHandle: globalThis.FileSystemDirectoryHandle,
                resolvePath: () => undefined, // No file paths in browser
            };
        },

        setupPerformanceMemory(_memoryMB?: number): void {
            // Browser has native performance.memory (Chrome) or
            // performance.measureMemory (standard). No polyfill needed.
        },

        patchWorkerConstructor(_memoryMB?: number): void {
            // Browser Workers don't have Deno globals to scrub.
            // The native Worker constructor is used as-is.
        },

        async bootstrapWebRTC(_payload: SandboxContextPayload): Promise<void> {
            // Browser has native WebRTC (RTCPeerConnection, etc.).
            // No polyfill needed.
        },

        buildBindingClients(_payload: SandboxContextPayload): Record<string, { fetch: typeof fetch }> {
            // In the browser, binding requests route through the parent
            // frame via postMessage. The parent acts as the mux proxy.
            //
            // TODO: Implement postMessage-based binding clients when
            // the browser hosting infrastructure is built.
            return {};
        },

        buildSpawnChild(_payload: SandboxContextPayload): (spawnArgs: string[], options?: any) => Promise<any> {
            // In the browser, spawn requests go to the parent frame
            // via postMessage. The parent creates a new iframe with
            // its own sandbox.
            //
            // TODO: Implement postMessage-based spawn when the browser
            // hosting infrastructure is built.
            return async () => ({ exitCode: 1, stdout: "", stderr: "spawn not available in browser\n" });
        },

        scrubGlobals(): void {
            // Browser doesn't have Deno/Node globals to scrub.
            // The iframe sandbox already provides a clean web environment.
        },

        setupSignalBridge(): { signal: AbortSignal } {
            // No OS signals in the browser. Return a never-aborted signal.
            return { signal: new AbortController().signal };
        },
    };
}
