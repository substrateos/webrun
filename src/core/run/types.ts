/**
 * Run subsystem types — shared between host and sandbox.
 *
 * The run subsystem prepares and spawns sandboxed executions.
 * Both the host (initial CLI invocation) and the sandbox
 * (nested ctx.run()) are consumers.
 */

import type { WebrunPermissions, WebrunLimits, WebrunLocationConfig, ImportMap } from "../types.ts";
import type { BundleInfo } from "../bundle.ts";

/** Security ceiling for nested runs. Constrains what a child can request. */
export interface RunCeiling {
    permissions: WebrunPermissions;
    limits: WebrunLimits;
    isolate: string[];
}

/**
 * Pre-resolved caller scope for buildRunFn.
 *
 * Carries the resolved output of config chain walking — aliases, merged config,
 * import map, and protected paths. Both the host and sandbox construct this from
 * different sources (filesystem config chain vs. descriptor), but buildRunFn
 * consumes the same shape.
 */
export interface RunContext {
    /** Alias map: name → absolute path. Lexically scoped from the caller's config chain.
     *  Inner names shadow outer. Already resolved against config dirs. */
    aliases: Record<string, string>;

    /** Merged base config (permissions, limits). No platform extensions — buildRunFn adds them fresh. */
    config: WebrunLocationConfig;

    /** Absolute paths of protected files (webrun.json, import maps) from the config chain. */
    protectedPaths: string[];

    /** Merged import map (all paths already absolute). */
    importMap: ImportMap;

    /** Working directory (absolute). */
    dir: string;
}

/** Host-level config that propagates down the process tree. */
export interface HostConfig {
    bundle: BundleInfo;
    spawner?: { socketPath: string; token: string };
    proxy?: { url: string; noProxy: string[]; caCertPath: string };
}

/** What run needs when spawning a child process. */
export interface SpawnOptions {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    pipeStdin: boolean;
}

/** What run gets back — a live handle to the spawned child. */
export interface ProcessHandle {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    stdin: WritableStream<Uint8Array> | null;
    exitCode: Promise<number>;
    kill(signal?: string): void;
}

/** Spawn function signature injected via RunDeps. */
export type SpawnFn = (opts: SpawnOptions) => Promise<ProcessHandle>;
