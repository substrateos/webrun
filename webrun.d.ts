// webrun.d.ts — Type declarations for webrun consumers.
//
// This file provides type-safe interfaces for:
//   - webrun.json configuration files (WebrunConfig)
//   - The runtime context object passed to guest modules (WebrunContext)
//   - Expected export signatures for entrypoints and test files
//
// Usage:
//   /// <reference path="./node_modules/webrun/webrun.d.ts" />
//   or add to tsconfig.json: { "types": ["webrun"] }

// =========================================================
// CONFIGURATION TYPES (webrun.json schema)
// =========================================================

/**
 * Storage access level for a relative directory path.
 * Controls what the sandboxed guest can do with files under that path.
 */
export type WebrunStorageAccess =
    | { access: "read"; airgap?: boolean }
    | { access: "write"; airgap?: boolean }
    | { access: "delegate"; ceiling: WebrunPermissions }
    | { access: "none" };

/**
 * Declarative permission boundaries for the sandbox.
 * All permissions are deny-by-default; only explicitly listed
 * capabilities are granted.
 */
export interface WebrunPermissions {
    /** Maps relative directory paths to read/write access levels. */
    storage?: Record<string, WebrunStorageAccess>;
    /** Allowed outbound network domains (["*"] for unrestricted). */
    network?: string[];
    /** Host environment variable names to inject into the sandbox. */
    env?: string[];
    /** Named bindings the guest is permitted to call. */
    bindings?: string[];
    /** Whether to grant WebGPU access. */
    gpu?: boolean;
    /** Whether to enable the WebRTC polyfill (CLI only; browsers have native WebRTC). */
    webrtc?: boolean;
    /**
     * Allowed remote hosts for ES module imports (["*"] for unrestricted).
     * Maps to Deno's --allow-import flag.
     * Default trusted hosts (deno.land, jsr.io, esm.sh, etc.) are always included.
     */
    import?: string[];
    /** Explicit capability delegations to specific subdirectories. */
    delegate?: Record<string, WebrunPermissions>;
}

/**
 * Scoped configuration applicable to both the root config and individual locations.
 * The root config IS a location config — it provides the global defaults.
 * Location-keyed entries narrow or extend these defaults for specific paths.
 */
export interface WebrunLocationConfig {
    /** Permission boundaries for the sandbox. */
    permissions?: WebrunPermissions;
    /** Resource constraints applied to the guest process. */
    limits?: {
        /** Maximum wall-clock time in milliseconds before the process is killed. */
        timeoutMillis?: number;
        /** Maximum RSS memory in megabytes. */
        memoryMB?: number;
    };
    /** Host-side binding service declarations (process or module). */
    bindings?: Record<string, any>;
    /** Path to an import map file for module resolution (relative to webrun.json). */
    importMap?: string;
    /** Unstable feature flags. */
    experimental?: {
        /**
         * OPFS persistence strategy.
         * - "git": Derives bucket ID from the repo's root commit hash (shared across clones).
         * - "path": Derives bucket ID from the canonical configDir path (per-directory).
         * When omitted, OPFS is ephemeral and destroyed on exit.
         */
        opfs?: { origin: "git" | "path" };
    };
}

/**
 * User-facing configuration loaded from webrun.json or package.json#webrun.
 * Extends WebrunLocationConfig — the root-level fields provide global defaults.
 */
export interface WebrunConfig extends WebrunLocationConfig {
    /** Short name aliases mapping to paths or URLs (e.g. `"default": "./main.ts"`). */
    aliases?: Record<string, string>;
    /** Path-keyed overrides that narrow the root config for specific entrypoints. */
    locations?: Record<string, WebrunLocationConfig>;
    /** Default execution entrypoint for --serve mode. */
    serve?: string;
    /**
     * Paths that, if accessed, strictly forbid the request of other capabilities
     * (e.g. network) to enforce an airgap.
     */
    isolate?: string[];
}

// =========================================================
// RUNTIME CONTEXT TYPES (passed to guest code)
// =========================================================

/**
 * TTY interface for terminal-aware applications (CLI only).
 * Not available in browser environments.
 */
export interface WebrunTty {
    /** Enable or disable raw mode on stdin. */
    setRawMode(raw: boolean): Promise<void>;
    /** Whether raw mode is currently enabled. */
    readonly isRaw: boolean;
    /** Terminal width in columns. */
    readonly columns: number;
    /** Terminal height in rows. */
    readonly rows: number;
}

/**
 * The runtime context object passed to guest modules via `webrun/ctx`.
 *
 * Available via:
 *   import { args, flags, env, dir, ... } from "webrun/ctx";
 *
 * Or as the second argument to test functions:
 *   export function testFoo(t: TestContext, ctx: WebrunContext) { ... }
 *
 * Or as the argument to a default entrypoint:
 *   export default function(ctx: WebrunContext) { ... }
 */
export interface WebrunContext {
    /** Positional arguments after `--` on the command line. */
    args: string[];
    /** Named flags parsed from the command line (e.g., --foo=bar → { foo: "bar" }). */
    flags: Record<string, string | boolean>;
    /** Environment variables injected via permissions.env in webrun.json. */
    env: Record<string, string>;
    /** Array containing the executable path and any sandbox-level arguments. */
    argv: string[];
    /** The canonical URL of the entrypoint file (e.g., file:///path/to/test.html). */
    location: string;
    /** The raw HTML source code of the entrypoint, if it was an HTML document. */
    srcdoc?: string;
    /** The sandboxed root directory (FileSystemDirectoryHandle). */
    dir: FileSystemDirectoryHandle;
    /** True when dir points to a persistent storage location (not a temp dir). */
    persisted: boolean;
    /** Named binding clients for host-side services. */
    bindings: Record<string, { fetch: typeof fetch }>;
    /** Readable stream for stdin. */
    stdin: ReadableStream<Uint8Array> | null;
    /** Writable stream for stdout. */
    stdout: WritableStream<Uint8Array> | null;
    /** Writable stream for stderr. */
    stderr: WritableStream<Uint8Array> | null;
    /** AbortSignal that fires when the process receives SIGTERM/SIGINT. */
    signal: AbortSignal;
    /** TTY interface (only available when stdin is a terminal). */
    tty?: WebrunTty;

    /** Exit the sandbox process with the given code. */
    exit(code?: number): never;
    /** Create a sandboxed temporary directory. Cleaned up on process exit. */
    makeTempDir(): Promise<FileSystemDirectoryHandle>;
    /** Upgrade an HTTP request to a WebSocket (--serve mode only). */
    upgradeWebSocket(request: Request): { socket: WebSocket; response: Response };

    /**
     * Spawn a child webrun process.
     *
     * @param args - Arguments for the child process.
     * @param options - Options for controlling the child process.
     * @returns Result with exitCode and optionally stdout/stderr.
     */
    webrun(args: string[], options?: {
        cwd?: FileSystemDirectoryHandle | string;
        env?: Record<string, string>;
        stdout?: WritableStream<Uint8Array>;
        stderr?: WritableStream<Uint8Array>;
        signal?: AbortSignal;
        timeoutMillis?: number;
        memoryMB?: number;
    }): Promise<{
        exitCode: number;
        stdout?: string;
        stderr?: string;
    }>;
}

// =========================================================
// EXPORT SIGNATURES
// =========================================================

/**
 * The expected default export signature for a webrun entrypoint module.
 *
 * @example
 * ```ts
 * const main: WebrunEntrypoint = async (ctx) => {
 *     console.log("Hello from", ctx.args);
 * };
 * export default main;
 * ```
 */
export type WebrunEntrypoint = (ctx: WebrunContext) => Promise<void> | void;

/**
 * The expected export signature for a webrun test function.
 * Test functions must be named with a `test` prefix (e.g., `testFoo`).
 *
 * @example
 * ```ts
 * export const testAddition: WebrunTestExport = async (t, ctx) => {
 *     t.assert(1 + 1 === 2, "math works");
 * };
 * ```
 */
export type WebrunTestExport = (
    t: {
        readonly name: string;
        run(name: string, fn: (t: any) => Promise<void>): Promise<void>;
        assert(condition: any, message?: string): void;
        fail(message?: string): void;
        skip(message?: string): never;
        log(...args: unknown[]): void;
    },
    ctx: WebrunContext,
) => Promise<void> | void;
