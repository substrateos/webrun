import type { RunArg } from "./run_arg.ts";
import type { TCPSocketConstructor } from "./direct_sockets/types.ts";

// W3C File System Access API — ambient type declarations.
// Deno's main-thread type space omits these; they exist at runtime in Workers.
// Declared here to match the spec interfaces implemented by file_system/adapters.
declare global {
    type FileSystemWriteChunkType =
        | BufferSource
        | Blob
        | string
        | { type: "write"; position?: number; data?: BufferSource | Blob | string | null }
        | { type: "seek"; position: number }
        | { type: "truncate"; size: number };

    interface FileSystemHandle {
        readonly kind: "file" | "directory";
        readonly name: string;
        isSameEntry(other: FileSystemHandle): Promise<boolean>;
    }

    interface FileSystemFileHandle extends FileSystemHandle {
        readonly kind: "file";
        getFile(): Promise<File>;
        createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
        createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
    }

    interface FileSystemDirectoryHandle extends FileSystemHandle {
        readonly kind: "directory";
        getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
        getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>;
        removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
        resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null>;
        entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>;
        keys(): AsyncIterableIterator<string>;
        values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
        [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>;
    }

    interface FileSystemWritableFileStream extends WritableStream<FileSystemWriteChunkType> {
        write(data: FileSystemWriteChunkType): Promise<void>;
        seek(position: number): Promise<void>;
        truncate(size: number): Promise<void>;
    }

    interface FileSystemSyncAccessHandle {
        read(buffer: ArrayBufferView, options?: { at?: number }): number;
        write(buffer: ArrayBufferView, options?: { at?: number }): number;
        truncate(newSize: number): void;
        getSize(): number;
        flush(): void;
        close(): void;
    }
}

export type WebrunStorageAccess =
    | { access: "read"; isolate?: boolean }
    | { access: "write"; isolate?: boolean }
    | { access: "delegate"; ceiling: WebrunPermissions }
    | { access: "none" };

/**
 * Resolve relative storage paths to absolute using URL resolution against a base dir.
 * This is the canonical resolution: `new URL(target, "file://" + baseDir + "/").pathname`.
 * Must be called at construction boundaries so all downstream code sees absolute paths.
 */
export function resolveStoragePaths(
    storage: Record<string, WebrunStorageAccess>,
    baseDir: string,
): Record<string, WebrunStorageAccess> {
    const result: Record<string, WebrunStorageAccess> = {};
    for (const [p, v] of Object.entries(storage)) {
        const pathname = new URL(p, "file://" + baseDir + "/").pathname;
        const abs = pathname.length > 1 && pathname.endsWith("/")
            ? pathname.slice(0, -1)
            : pathname;
        result[abs || "/"] = v;
    }
    return result;
}

export interface WebrunLimits {
    timeoutMillis?: number;
    memoryMB?: number;
}

export interface WebrunPermissions {
    /** Maps relative directory paths to read/write access levels. */
    storage?: Record<string, WebrunStorageAccess>;
    /** Allowed outbound network domains (["*"] for unrestricted). */
    network?: string[];
    /** Host environment variable names to inject into the sandbox. */
    env?: string[];
    /** Whether to grant WebGPU access. */
    gpu?: boolean;
    /** Whether to enable the WebRTC polyfill (CLI only; browsers have native WebRTC). */
    webrtc?: boolean;
    /** Allowed remote hosts for ES module imports (["*"] for unrestricted). */
    import?: string[];
    /** Explicit capability delegations to specific subdirectories. */
    delegate?: Record<string, WebrunPermissions>;
    /**
     * Allowed executable binary prefixes for the OS jail.
     * Each entry is a command prefix (e.g. ["/usr/bin/git", "rev-list"]).
     * A spawned command must match at least one prefix to be permitted.
     */
    binaries?: string[][];
    /** Whether this context can spawn child webrun processes via ctx.run(). */
    run?: boolean;
    /** Whether to allow converting filesystem handles to URLs.
     *  Exposes the underlying path structure — must be explicitly granted per location. */
    createFileSystemHandleURL?: boolean;
    /** Whether to grant direct TCP socket access (Direct Sockets API). */
    tcp?: boolean;
}

/** Scoped configuration applicable to both the root config and individual locations. */
export interface WebrunLocationConfig {
    /** Permission boundaries for the sandbox. */
    permissions?: WebrunPermissions;
    /** Resource constraints applied to the guest process. */
    limits?: WebrunLimits;
    /** Path to an import map file for module resolution (relative to webrun.json). */
    importMap?: string;
    /**
     * Extension middleware chain. Keys are extension identifiers:
     * - Built-in: `@webrun/<name>` (e.g., `@webrun/opfs`, `@webrun/check`)
     * - User: relative path (e.g., `./extensions/my-ext.js`)
     * Values are per-extension config objects. Order determines execution order.
     */
    extensions?: Record<string, Record<string, unknown>>;
    /** Working directory override for targets matching this location.
     *  Resolved relative to the declaring config's directory. */
    dir?: string;
    /** Env var name to inject the allocated serve port under for binary mode targets.
     *  Defaults to "PORT" when omitted. */
    portEnv?: string;
}

/** User-facing configuration loaded from webrun.json. */
export interface WebrunConfig extends WebrunLocationConfig {
    /** Short name aliases mapping to paths or URLs (e.g. `"default": "./main.ts"`). */
    aliases?: Record<string, string>;
    /** Path-keyed overrides that narrow the root config for specific entrypoints. */
    locations?: Record<string, WebrunLocationConfig>;
    /** Default execution entrypoint for --serve mode. */
    serve?: string;
    /** Paths that, if accessed, strictly forbid the request of other capabilities (e.g. network) to enforce network isolation. */
    isolate?: string[];
}

/** Enumerated security violation codes. */
export enum SecurityViolation {
    /** Child config escalates a capability not granted by a parent config. */
    CapabilityEscalation = "CapabilityEscalation",
    /** Child config exceeds the security ceiling imposed by a parent run. */
    CeilingViolation = "CeilingViolation",
    /** Network access requested for a path under an isolate directive. */
    NetworkIsolation = "NetworkIsolation",
    /** Binary execution denied — command does not match any allowed prefix. */
    BinaryDenied = "BinaryDenied",
    /** Write path overlaps with a protected executable. */
    SandboxSafety = "SandboxSafety",
    /** The requested operation requires a permission that was not granted. */
    PermissionDenied = "PermissionDenied",
}

/** Structural context for a security violation — carried as DOMException.cause. */
export interface ViolationContext {
    code: SecurityViolation;
    /** Human-readable description of this specific violation. */
    message: string;
    /** The config directory requesting the escalated capability. */
    child: string;
    /** The parent config directory that does not grant the capability. */
    parent: string;
    /** Domain-specific diagnostic details (e.g. isolated paths). */
    extras?: Record<string, string>;
}

/** Create a DOMException with name "SecurityError" and structured ViolationContext as cause. */
export function securityError(message: string, context?: ViolationContext): DOMException {
    const err = new DOMException(message, "SecurityError");
    if (context) err.cause = context;
    return err;
}

/** Options for `ctx.run()` — the unified process spawning primitive. */
export interface RunOptions {
    /** Working directory capability. Adapter resolves the underlying path. */
    dir?: FileSystemDirectoryHandle;

    /** Environment variables for the child process. */
    env?: Record<string, string>;

    /** AbortSignal for cancellation. When aborted, SIGTERM is sent to the child. */
    signal?: AbortSignal;

    /** Data piped to the child's stdin. Closed after the stream ends. */
    stdin?: ReadableStream<Uint8Array>;

    /**
     * Execution mode. Inferred from the target when omitted.
     * - "module": runs a JS/TS module via the runtime; permissions map to runtime flags + OS jail.
     * - "binary": runs an executable directly; permissions map to OS jail only. Command must match a `permissions.binaries` prefix.
     */
    mode?: "module" | "binary";

    serve?: (string | URL)[]

    /** When provided, the adapter enforces these capabilities via runtime-specific sandboxing. */
    permissions?: WebrunPermissions;

    /** Resource constraints applied to the child process. */
    limits?: { timeoutMillis?: number; memoryMB?: number };

    /** Import map object — adapter serializes to a file and passes to the runtime. */
    importMap?: Record<string, unknown>;

    /** Explicit storage grants for the child process.
     *  Each entry grants the child read or write access to the handle's path. */
    storage?: Array<{ handle: FileSystemDirectoryHandle | FileSystemFileHandle; access: "read" | "write" }>;

    /** When true, deduplicates by resolved target path (SharedWorker semantics).
     *  Forbids all other options. The returned RunHandle exposes only urls and exitCode. */
    shared?: boolean;
}

/**
 * Live handle to a running child process.
 *
 * Returned by `ctx.run()`. Streams are live and can be piped or consumed:
 * - `exitCode` resolves when the process exits.
 * - `stdout`/`stderr` are readable streams that end on pipe EOF.
 * - `signal()` sends an OS signal to the child.
 */
export interface RunHandle {
    /** Resolves with the process exit code. */
    exitCode: Promise<number>;
    /** Live stream of the child's stdout. Ends on EOF. */
    stdout: ReadableStream<Uint8Array>;
    /** Live stream of the child's stderr. Ends on EOF. */
    stderr: ReadableStream<Uint8Array>;
    /** Send an OS signal to the child process (e.g. "SIGTERM", "SIGKILL"). */
    signal(sig: string): void;
    /** Resolves when the child calls ctx.serve(). Empty array if serve is never called. */
    urls: Promise<URL[]>;
}

import type { ServeContext, ServeHandler, ServeOptions, ServeResult } from "./serve/types.ts";
export type { ServeContext, ServeHandler, ServeOptions, ServeResult };

export interface ImportMap {
    imports?: Record<string, string>;
    scopes?: Record<string, Record<string, string>>;
}

/**
 * Context represents the highest privilege capability model in WebRun.
 * It provides standard Web/WebRun APIs to the orchestrator, allowing the
 * host logic to be completely runtime-agnostic.
 */
export interface CoreContext {
    argv: readonly string[];
    args: readonly string[];
    flags: Record<string, unknown>;
    env: Record<string, string>;
    dir?: FileSystemDirectoryHandle; // Working directory — only set when storage is declared

    /** The target module URL or path to execute. */
    location: string;

    /** Module-like metadata for the target. Analogous to import.meta.
     *  url: the fully resolved file:// URL of the target.
     *  cwd: the file:// URL of the working directory.
     *  resolve: resolves a specifier against the target URL, consulting the import map. */
    meta: { url: string; cwd: string; resolve: (specifier: string) => string };

    /** The active permissions for this context. Extensions use this to enforce
     *  capability ceilings — a child process must not exceed the parent's grants. */
    permissions?: WebrunPermissions;

    limits?: WebrunLimits;

    /** Extension-contributed import map entries, merged into the final import map. */
    importMap?: ImportMap;

    /** Generic extension metadata. Extensions write namespaced data here;
     *  the orchestrator passes it through to the sandbox payload untouched. */
    extensions?: Record<string, unknown>;

    /** Abort signal for graceful shutdown (forwarded from OS signals). */
    signal: AbortSignal;

    /** Standard input stream, or null when not available. */
    stdin: ReadableStream<Uint8Array> | null;

    /** Standard output stream, or null when not available. */
    stdout: WritableStream<Uint8Array> | null;

    /** Standard error stream, or null when not available. */
    stderr: WritableStream<Uint8Array> | null;

    /** Terminal control. Null when stdin is not a TTY (e.g. piped). */
    tty: {
        setRawMode(raw: boolean): Promise<void>;
        isRaw(): Promise<boolean>;
        consoleSize(): Promise<{ columns: number; rows: number }>;
    } | null;

    run: ((args: (string | RunArg)[], options?: RunOptions) => Promise<RunHandle>) & {
        /** Tagged template for args that reference handles. Grants the child
         *  read access to the handle's underlying path. */
        arg: (strings: TemplateStringsArray, ...values: any[]) => RunArg;
    };

    /** Terminate the host process with the given exit code. */
    exit: (code: number) => never;
}

export interface Context extends CoreContext {
    makeTempDir: (options?: { prefix?: string }) => Promise<FileSystemDirectoryHandle>;

    /** Convert a file or directory handle to a file:// URL string.
     *  Directory handles produce a trailing-slash URL (prefix matching).
     *  Requires permissions.createFileSystemHandleURL to be granted. */
    createFileSystemHandleURL: (handle: FileSystemFileHandle | FileSystemDirectoryHandle) => string;

    /** Start an HTTP server on one or more listen addresses.
     *  Pass URL strings like `"http://127.0.0.1:8080"` or `"http://0.0.0.0:0"`.
     *  When `listen` is omitted, binds a single ephemeral `http://127.0.0.1:0`.
     *  Abort the signal to shut down the server.
     *  Returns resolved URLs with actual ports filled in. */
    serve: (handler: ServeHandler, options?: ServeOptions) => Promise<ServeResult>;

    /** Direct TCP socket constructor. Only available when permissions.tcp is granted.
     *  Usage: `const sock = new ctx.TCPSocket("127.0.0.1", 8443);` */
    TCPSocket: TCPSocketConstructor;

    /** Access extension-specific storage and utilities. Only available to extensions. */
    extensionData?: () => Promise<{ dir: FileSystemDirectoryHandle; hashForFileSystemHandle: (h: any) => Promise<string> }>;
}

/** Context available inside a serve handler. Extends the base Context
 *  with the ability to upgrade HTTP requests to WebSocket connections. */
export interface FetchContext extends Context {
    upgradeWebSocket: (options?: { protocol?: string; idleTimeout?: number }) => { socket: WebSocket; response: Response };
}

export interface ExtensionContext extends Context {
    /** The extension's registry key (e.g. "@webrun/opfs"). */
    extensionKey: string;
}

export type WebrunDefaultExport =
    | {
        fetch?: (request: Request, ctx: FetchContext) => Promise<Response>;
        main?: (args: readonly string[], env: Record<string, string>, ctx: Context) => Promise<void>;
    }
    | ((ctx: Context) => Promise<void>);
