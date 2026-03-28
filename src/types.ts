// =========================================================
// 1. TYPES & DOMAIN MODELS
// =========================================================

/** User-facing configuration loaded from webrun.json or package.json#webrun. */
export interface WebrunConfig {
    /** Resource constraints applied to the guest process. */
    limits?: { timeoutMillis?: number, memoryMB?: number };
    /** Declarative permission boundaries for the sandbox. */
    permissions?: {
        /** Maps relative directory paths to read/write access levels. */
        storage?: Record<string, { access: "read" | "write" }>;
        /** Allowed outbound network domains (["*"] for unrestricted). */
        network?: string[];
        /** Host environment variable names to inject into the sandbox. */
        env?: string[];
        /** Named bindings the guest is permitted to call. */
        bindings?: string[];
        /** Whether to grant WebGPU access. */
        gpu?: boolean;
    };
    /** Host-side binding service declarations (process or module). */
    bindings?: Record<string, any>;
    /** Path to an import map file for module resolution. */
    importMap?: string;
    /** Default execution entrypoint for --module mode. */
    module?: string;
    /** Default execution entrypoint for --serve mode. */
    serve?: string;
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
    isSelfTest?: boolean;
    targetScriptPath: string;
    targetModule?: string;
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
}

/**
 * Serialized payload written to disk and read by the guest process.
 * Contains everything the inner sandbox needs to configure itself.
 */
export interface SandboxContextPayload {
    action: "run" | "test" | "eval" | "check-only" | "serve";
    isSelfTest?: boolean;
    /** Absolute path to the webrun binary (for child spawning). */
    webrunBin?: string;
    isRepackedTest?: boolean;
    isSelfCheck?: boolean;
    /** Absolute path to the host directory mapped as ctx.dir. */
    storageRoot: string;
    /** True when no storage permissions are declared (uses a temp dir). */
    fallbackToTemp: boolean;
    injectedArgsObj: Record<string, any>;
    /** Environment variables to expose inside the sandbox. */
    finalEnvVars: Record<string, string>;
    targetUrlHref: string;
    targetScriptPath: string;
    evalCode?: string;
    sandboxArgs: string[];
    /** Absolute path to the OPFS root (ephemeral or persistent). */
    opfsRoot: string;
    memoryMB?: number;
    bindingsMap: Record<string, BindingEntry>;
    allowedBindings: string[];
    allowGpu?: boolean;
    /** Port of the host-side mux proxy (null if no process bindings). */
    muxPort?: number | null;
    /** Mapping of binding name → bearer token for mux proxy auth. */
    tokenMap?: Record<string, string>;
    serveInterfaces?: { host: string; port: number }[];
    config?: WebrunConfig;
    configDir?: string;
    /**
     * Absolute path to the runner's ephemeral temp directory.
     * Used by ctx.makeTempDir() to create sandboxed scratch directories.
     * Always cleaned up on process exit.
     */
    runnerTmp?: string;
    /** Inline filter pattern from --test=<pattern>. */
    filterPattern?: string;
    /** Additional test module URLs for multi-module --test mode. */
    additionalTargetUrls?: string[];
    /** Additional test module paths for multi-module --test mode. */
    additionalTargetPaths?: string[];
    /** Landlock policy for Linux self-sandboxing. Undefined on non-Linux. */
    landlockPolicy?: LandlockPolicy;
}


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
    type: "process" | "module";
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
    'consoleSize' | 'test' | 'Command' | 'execPath' | 'listen' | 'serve' |
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
