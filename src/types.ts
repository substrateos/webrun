// =========================================================
// 1. TYPES & DOMAIN MODELS
// =========================================================

/** A localized request for capabilities during the OCap evaluation chain. */
export interface CapabilityRequest {
    network: string[];
    storage: { path: string; access: "read" | "write" }[];
    env: string[];
    bindings: string[];
    import: string[];
    gpu: boolean;
    webrtc: boolean;
}

export type WebrunStorageAccess =
    | { access: "read"; airgap?: boolean }
    | { access: "write"; airgap?: boolean }
    | { access: "delegate"; ceiling: WebrunPermissions }
    | { access: "none" };

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

/** Scoped configuration applicable to both the root config and individual locations. */
export interface WebrunLocationConfig {
    /** Permission boundaries for the sandbox. */
    permissions?: WebrunPermissions;
    /** Resource constraints applied to the guest process. */
    limits?: { timeoutMillis?: number; memoryMB?: number };
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

/** User-facing configuration loaded from webrun.json or package.json#webrun. */
export interface WebrunConfig extends WebrunLocationConfig {
    /** Short name aliases mapping to paths or URLs (e.g. `"default": "./main.ts"`). */
    aliases?: Record<string, string>;
    /** Path-keyed overrides that narrow the root config for specific entrypoints. */
    locations?: Record<string, WebrunLocationConfig>;
    /** Default execution entrypoint for --serve mode. */
    serve?: string;
    /** Paths that, if accessed, strictly forbid the request of other capabilities (e.g. network) to enforce an airgap. */
    isolate?: string[];
}

/** Landlock policy for Linux self-sandboxing (serialized into the sandbox payload). */
export interface LandlockPolicy {
    /** Paths the guest may read (canonicalized). */
    read_paths: string[];
    /** Paths the guest may write (canonicalized). */
    write_paths: string[];
    /** Paths the guest may execute (typically just the runtime binary). */
    exec_paths: string[];
    /** TCP ports the guest may connect to (defense-in-depth, ABI 4+). */
    tcp_connect_ports: number[];
    /** TCP ports the guest may bind (ephemeral relay ports, ABI 4+). */
    tcp_bind_ports: number[];
    /** Whether GPU device access is allowed (ABI 5+). */
    gpu: boolean;
}

/** Parsed result of CLI argument routing. */
export interface CommandInvocation {
    action: "run" | "test" | "eval" | "check-only" | "serve";
    targetScriptPath: string;
    /** The key of the matched location alias, if any. */
    resolvedLocationKey?: string;
    evalCode?: string;
    sandboxArgs: string[];
    injectedArgsObj: Record<string, any>;
    networkFlags: string[];
    isNoCheck?: boolean;
    serveInterfaces?: { host: string; port: number }[];
    /** Inline filter pattern from --test=<pattern>. */
    filterPattern?: string;
    /** Additional test module paths for multi-module --test mode. */
    additionalTargets?: string[];
    /**
     * Maps each script path to its original location URL.
     * Used to provide per-test ctx.location.
     */
    scriptLocations?: Record<string, string>;
    /**
     * Maps each location URL to its HTML source (deduplicated).
     * Used to provide per-test ctx.srcdoc.
     */
    srcdocs?: Record<string, string>;
}

/**
 * Shared fields present in every sandbox payload regardless of action.
 * Contains everything the inner sandbox needs to configure itself.
 */
interface CommonPayload {
    /** Absolute path to the host directory mapped as ctx.dir. */
    storageRoot: string;
    /** True when no storage permissions are declared (uses a temp dir). */
    fallbackToTemp: boolean;
    injectedArgsObj: Record<string, any>;
    /** Environment variables to expose inside the sandbox. */
    finalEnvVars: Record<string, string>;
    targetUrlHref: string;
    targetScriptPath: string;
    sandboxArgs: string[];
    /** Absolute path to the OPFS root (ephemeral or persistent). */
    opfsRoot: string;
    memoryMB?: number;
    bindingsMap: Record<string, BindingEntry>;
    allowedBindings: string[];
    allowGpu?: boolean;
    /** Port of the host-side mux proxy (null if no process bindings). */
    muxPort?: number | null;
    config?: WebrunConfig;
    /** Location-specific permissions that narrow the global config. */
    locationPermissions?: WebrunPermissions;
    configDir?: string;
    /**
     * Absolute path to the runner's ephemeral temp directory.
     * Used by ctx.makeTempDir() to create sandboxed scratch directories.
     * Always cleaned up on process exit.
     */
    runnerTmp?: string;
    /** Landlock policy for Linux self-sandboxing. Undefined on non-Linux. */
    landlockPolicy?: LandlockPolicy;
    /** Bearer token for the host-side spawn server (ctx.webrun() IPC). */
    spawnToken?: string;
    /**
     * Maps each script path to its original location URL.
     * Used to provide per-test ctx.location.
     */
    scriptLocations?: Record<string, string>;
    /**
     * Maps each location URL to its HTML source (deduplicated).
     * Used to provide per-test ctx.srcdoc.
     */
    srcdocs?: Record<string, string>;
    /** Self-test marker (internal use). */
    isSelfCheck?: boolean;
}

/**
 * Discriminated union for the sandbox payload.
 * Each variant carries only the fields relevant to its action.
 */
export type SandboxContextPayload =
    | CommonPayload & { action: "run" }
    | CommonPayload & { action: "check-only" }
    | CommonPayload & { action: "eval"; evalCode: string }
    | CommonPayload & { action: "test"; filterPattern?: string; additionalTargetUrls?: string[]; additionalTargetPaths?: string[] }
    | CommonPayload & { action: "serve"; serveInterfaces: { host: string; port: number }[] };


// =========================================================
// 2. RUNTIME CAPABILITY TYPES
// =========================================================
//
// Per-module runtime type aliases.
// Each module declares exactly which system capabilities it needs.
// Swappable to custom interfaces if the underlying runtime changes.

/** Portable signal name — mirrors the runtime's signal type. */
export type Signal = Deno.Signal;

/** Portable network address — mirrors the runtime's listener addr type. */
export type NetAddr = Deno.NetAddr;

/** Resolved binding entry — describes a process or module binding. */
export interface BindingEntry {
    type: "process";
    uuid: string;
    path?: string;
    port?: number;
    /** Bearer token for mux proxy authentication (process bindings only). */
    token?: string;
}

/** Options for spawning a child command — mirrors the runtime's constructor arg. */
export type CommandOptions = NonNullable<ConstructorParameters<typeof Deno.Command>[1]>;

/** serve.ts — static file server and fetch-handler mode. */
export type ServeRuntime = Pick<typeof Deno, 'exit' | 'addSignalListener' | 'readFileSync' | 'stat' | 'serve' | 'build'>;

/** jail.ts — process image construction and OS-level enforcement. */
export type JailRuntime = Pick<typeof Deno, 'execPath' | 'Command' | 'realPathSync'>
    & { env?: RuntimeEnv };

/** Minimal env interface — structurally compatible with the runtime's env object. */
export interface RuntimeEnv { get(key: string): string | undefined; toObject?(): Record<string, string> }

/**
 * Wraps globalThis.Deno into an env-compatible runtime object.
 * Used by public API overloads that must provide a default sys when callers
 * use the legacy 1-arg signature. This is the single sanctioned site for
 * accessing globalThis.Deno outside of webrun.ts.
 */
export function adaptGlobalRuntime(): Omit<typeof Deno, 'env'> & { env: RuntimeEnv } {
    const d = globalThis.Deno;
    return { ...d, env: d.env };
}

/** policy.ts — config discovery, permission narrowing, seatbelt generation. */
export type PolicyRuntime = Pick<typeof Deno, 'exit' | 'readTextFileSync' | 'statSync' | 'writeTextFileSync' | 'realPathSync'> & { env: RuntimeEnv };

/** config.ts — CLI parsing, webrun.json loading, payload construction. */
export type ConfigRuntime = Pick<typeof Deno, 'cwd' | 'exit' | 'statSync' | 'readTextFileSync'> & { env: RuntimeEnv };

/** fs.ts — OPFS / FileSystemAccessAPI storage engine. */
export type StorageRuntime = Pick<typeof Deno,
    'stat' | 'lstat' | 'readFile' | 'writeFile' | 'remove' | 'mkdir' |
    'readDir' | 'open' | 'openSync' | 'realPath' | 'errors' | 'SeekMode'>;

/** guest.ts — sandbox interior: globals, signals, test harness, ctx object. */
export type GuestRuntime = Pick<typeof Deno,
    'exit' | 'memoryUsage' | 'addSignalListener' | 'stdin' | 'stdout' | 'stderr' |
    'consoleSize' | 'Command' | 'execPath' | 'listen' | 'serve' |
    'upgradeWebSocket' | 'readTextFileSync' | 'readFileSync' | 'readDirSync' |
    'writeTextFileSync' | 'writeFileSync' | 'mkdirSync' | 'makeTempDirSync' |
    'symlinkSync' | 'removeSync' | 'statSync' | 'realPathSync' |
    'stat' | 'lstat' | 'readFile' | 'writeFile' | 'remove' | 'mkdir' |
    'readDir' | 'open' | 'openSync' | 'realPath' | 'errors' | 'SeekMode' |
    'build' | 'networkInterfaces'> & { env: RuntimeEnv };

/** host.ts — outer orchestrator: config, policy, jail, audit, cleanup. */
export type HostRuntime = Pick<typeof Deno,
    'exit' | 'Command' | 'execPath' | 'cwd' | 'args' | 'build' |
    'readTextFileSync' | 'writeTextFileSync' | 'realPathSync' | 'mkdirSync' |
    'makeTempDirSync' | 'openSync' | 'removeSync' | 'statSync' | 'listen' | 'serve' |
    'addSignalListener' | 'removeSignalListener' | 'stdin' | 'consoleSize'> & { env: RuntimeEnv };

/** tests/external/ — host-validated test runner. */
export type TestExternalRuntime = Pick<typeof Deno,
    'readDirSync' | 'readTextFileSync' | 'readFileSync' |
    'writeTextFileSync' | 'writeFileSync' | 'copyFileSync' |
    'mkdirSync' | 'removeSync' | 'makeTempDirSync' | 'realPathSync' | 'statSync' |
    'Command' | 'execPath' | 'listen' | 'serve' | 'test'> & { env: RuntimeEnv };

