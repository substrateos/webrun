/**
 * IPC contract definitions for the sandbox↔worker boundary.
 *
 * One boundary exists:
 *   Sandbox ↔ Worker (Worker postMessage, Comlink)
 *
 * The host↔sandbox boundary was removed in Phase 2 — the sandbox reads its
 * ContextDescriptor from a temp file and handles ctx.run() directly.
 */

import type { ResolvedCapabilities } from "./capabilities.ts";
import type { BundleInfo } from "./bundle.ts";
import type { Context, ImportMap, RunHandle, RunOptions, WebrunLocationConfig } from "./types.ts";

/** Opaque reference to a directory the host has exposed. */
export interface HandleRef {
    uuid: string;
    path: string[];
}

/**
 * Unified sandbox descriptor.
 *
 * Carries everything the sandbox process needs for both jail setup and
 * guest execution. The parent builds this once and writes it to a temp file.
 *
 * - `caps`: guest capabilities — used for OS jail (seatbelt/landlock)
 * - `drop`: jail-only capabilities to revoke after OS jail is applied
 * - `mode`: determines whether to exec a binary or run a module in-process
 */
export interface ContextDescriptor {
    caps: ResolvedCapabilities;
    drop: Partial<ResolvedCapabilities>;

    mode: 'binary' | 'module';

    /** Host services inherited by children. */
    host: {
        bundle: BundleInfo;
        spawner?: { socketPath: string; token: string };
        proxy?: { url: string; noProxy: string[]; caCertPath: string };
    };

    binary?: {
        command: string;
        args: string[];
        env: Record<string, string>;
    };

    module?: {
        argv: string[];
        args: string[];
        flags: Record<string, any>;
        env: Record<string, string>;
        config: WebrunLocationConfig;
        /** Pre-resolved alias map from the caller's config chain (lexical scope). */
        aliases: Record<string, string>;
        /** Absolute paths of protected files (webrun.json, import maps). */
        protectedPaths: string[];
        fs: {
            /** Working directory path. Undefined when the caller didn't provide one. */
            dir?: string;

            /** Persistent storage root for extensions. */
            extensionsDir: string;

            /** Temporary scratch directory for the current invocation. */
            tempDir: string;

            /** Persistent data directory. */
            dataDir: string;

            /** Runtime cache directory. */
            cacheDir: string;
        };
        /** A list of urls that the fetch function is bound to. */
        urls: string[];
        target: string;
        /** Import map object — sandbox serializes to temp and passes to the runtime. */
        importMap?: ImportMap;
    };
}

/**
 * Sandbox → Worker (reverse direction).
 * Provided to the worker via init(). The worker calls
 * these to interact with the sandbox process.
 */
export interface WorkerContext extends Pick<Context, "exit" | "tty"> {
    /** Spawn a child webrun process. Resolves with a RunHandle once spawned. */
    run(args: string[], options?: RunOptions): Promise<RunHandle>;
    /** Register a callback to be invoked when the sandbox's signal aborts. */
    onAbort(callback: () => void): void;
}

export interface WorkerStdio {
    stdin: ReadableStream<Uint8Array> | null
    stdout: WritableStream<Uint8Array> | null
    stderr: WritableStream<Uint8Array> | null
}

/**
 * Worker API.
 * Exposed by the worker (via postMessage) to the sandbox process.
 * The sandbox calls init() once to bootstrap the guest module.
 */
export interface WorkerAPI {
    init(descriptor: ContextDescriptor, stdio: WorkerStdio, ctx: WorkerContext, ports?: Record<string, MessagePort>): Promise<void>;
}
