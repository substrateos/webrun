// =========================================================
// ENVIRONMENT ADAPTER INTERFACE
// =========================================================
//
// The adapter is the thin seam between the guest trampoline and the
// execution environment. It provides environment-specific primitives
// that the shared trampoline composes into the ctx object.
//
// The GuestRuntime type (types.ts) already abstracts the system
// primitives (exit, memoryUsage, stdin, stdout, etc.). The adapter
// handles the higher-level, environment-specific orchestration that
// GuestRuntime doesn't cover.
//
// CLI adapter (adapters/cli.ts): Deno file APIs, mux proxy bindings,
//   OS signal bridge, global scrubbing, Worker patching.
//
// Browser adapter (adapters/web.ts): native OPFS, postMessage
//   bindings, no signal bridge, no global scrubbing.

import type { SandboxContextPayload } from "./types.ts";

/**
 * Storage primitives provided by the adapter.
 *
 * On CLI: backed by Deno file APIs (captured before scrub).
 * On browser: native OPFS or IPC to host.
 */
export interface AdapterStorage {
    /** OPFS-compatible StorageManager. */
    manager: any;
    /** FileSystemDirectoryHandle constructor for makeTempDir. */
    FileSystemDirectoryHandle: any;
    /** Resolves a FileSystemHandle to its absolute path (CLI only). */
    resolvePath: (h: any) => string | undefined;
}

/**
 * Environment-specific adapter that the shared trampoline calls
 * to set up the sandbox. Each method provides a narrow, composable
 * primitive — the trampoline composes them into the full ctx object.
 *
 * Methods are called in a fixed order by the trampoline:
 *   1. captureFetch() — before any globals are modified
 *   2. createStorage() — before global wipe, needs file APIs
 *   3. setupPerformanceMemory() — polyfill before user code
 *   4. patchWorkerConstructor() — before user code spawns Workers
 *   5. bootstrapWebRTC() — before global wipe, needs Node globals
 *   6. buildBindingClients() — before global wipe, uses captured fetch
 *   7. buildSpawnChild() — before global wipe, uses captured fetch
 *   8. scrubGlobals() — irrevocable, last environment mutation
 *   9. setupSignalBridge() — after scrub, uses sys.addSignalListener
 */
export interface EnvironmentAdapter {
    /**
     * Capture the native fetch before any globals are modified.
     */
    captureFetch(): typeof fetch;

    /**
     * Set up a storage layer.
     *
     * Two modes exist because OPFS (navigator.storage) and ctx.dir
     * can have different roots:
     *   - "opfs": always uses payload.opfsRoot with fallbackToTemp=true
     *   - "ctx": uses payload.storageRoot with payload.fallbackToTemp
     *
     * CLI: Deno file APIs captured before scrub.
     * Browser: native OPFS or IPC to host.
     */
    createStorage(payload: SandboxContextPayload, mode: "opfs" | "ctx"): AdapterStorage;

    /**
     * Set up performance.memory and performance.measureMemory polyfills.
     * CLI: backed by Deno.memoryUsage().
     * Browser: no-op (natively available).
     */
    setupPerformanceMemory(memoryMB?: number): void;

    /**
     * Wrap the Worker constructor to scrub globals in spawned workers.
     * CLI: injects a scrubbing preamble into user-spawned Workers.
     * Browser: no-op (browser Workers don't have Deno).
     */
    patchWorkerConstructor(memoryMB?: number): void;

    /**
     * Bootstrap WebRTC polyfill if the payload includes a UDP port.
     * Must be called before scrubGlobals() — needs Node globals.
     * CLI: captures Buffer/process/setImmediate, injects into werift.
     * Browser: no-op (native WebRTC).
     */
    bootstrapWebRTC(payload: SandboxContextPayload): Promise<void>;

    /**
     * Build per-binding fetch closures.
     * CLI: routes through the mux proxy with bearer tokens.
     * Browser: routes through parent.postMessage.
     */
    buildBindingClients(payload: SandboxContextPayload): Record<string, { fetch: typeof fetch }>;

    /**
     * Build the spawn child function for ctx.webrun().
     * CLI: HTTP to mux proxy spawn server.
     * Browser: postMessage to parent.
     */
    buildSpawnChild(payload: SandboxContextPayload): (spawnArgs: string[], options?: any) => Promise<any>;

    /**
     * Irrevocably delete all non-web globals.
     * CLI: deletes Deno, process, Buffer, etc.
     * Browser: no-op.
     */
    scrubGlobals(): void;

    /**
     * Set up signal bridge for process lifecycle.
     * CLI: bridges OS signals to AbortSignal via lazy listeners.
     * Browser: returns a never-aborted signal.
     */
    setupSignalBridge(): { signal: AbortSignal };
}
