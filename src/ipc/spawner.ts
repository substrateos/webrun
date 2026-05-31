import { makeFdlink } from "../core/fdlink/mod.ts";
import type { FdlinkDeps } from "../core/fdlink/mod.ts";
import { wrap, transfer, JSONStream } from "../core/fdlink/rpc.ts";
import type { SpawnFn, SpawnOptions, ProcessHandle, HostConfig } from "../core/run/types.ts";
import type { DenoRuntime } from "../deno/run/deps.ts";
import { directSpawn } from "../deno/run/spawn.ts";

type Transferable = ReadableStream<Uint8Array> | WritableStream<Uint8Array>;

/** The API surface the spawner exposes over a connection. */
interface SpawnerAPI {
    spawn(
        request: { token: string; command: string; args: string[]; env: Record<string, string>; cwd: string },
        pipes: Transferable[],
    ): Promise<{
        pid: number;
        exitCode: Promise<number>;
        signal(sig: string): Promise<void>;
    }>;
}

/**
 * Spawn a child via the spawner daemon over UDS.
 *
 * Creates pipe pairs for stdout/stderr (and optionally stdin),
 * transfers child-side ends to the spawner via SCM_RIGHTS,
 * and returns ReadableStreams from the parent-side pipe ends.
 */
export async function udsSpawn(transport: ReturnType<typeof makeFdlink>, socketPath: string, token: string, opts: SpawnOptions): Promise<ProcessHandle> {
    // 1. Create pipe pairs — same shape as TransformStream.
    const stdoutPipe = transport.pipe();
    const stderrPipe = transport.pipe();
    const stdinPipe = transport.pipe();
    if (!opts.pipeStdin) {
        // Close write end → child reads EOF on stdin.
        const w = stdinPipe.writable.getWriter();
        await w.close();
    }

    // 2. Connect to spawner and get typed proxy.
    const conn = transport.connect(socketPath);
    const spawner = wrap<SpawnerAPI>(new JSONStream(conn));

    try {
        // 3. Spawn via RPC — pipes are transferred via SCM_RIGHTS.
        const child = await spawner.spawn(
            { token, command: opts.command, args: opts.args, env: opts.env, cwd: opts.cwd },
            transfer([stdinPipe.readable, stdoutPipe.writable, stderrPipe.writable]),
        );

        // 4. Return parent-side pipe ends as the ProcessHandle.
        //    Close the connection after exit to terminate wrap()'s background reader.
        const exitCode = child.exitCode.then(
            (code: number) => { conn.close(); return code; },
            (err: any) => { conn.close(); throw err; }
        );
        return {
            stdout: stdoutPipe.readable,
            stderr: stderrPipe.readable,
            stdin: opts.pipeStdin ? stdinPipe.writable : null,
            exitCode,
            kill: (sig: string = "SIGTERM") => { child.signal(sig).catch(() => {}); },
        };
    } catch (e) {
        conn.close();
        throw e;
    }
}

// ─── Public API ───

/**
 * Connect to the spawn subsystem.
 *
 * If the host config includes a spawner (macOS seatbelt path), creates
 * a UDS transport and returns a SpawnFn that delegates to the spawner.
 * Otherwise, returns a direct SpawnFn via Deno.Command.
 */
export function connectSpawner(host: HostConfig, deno: DenoRuntime & Partial<FdlinkDeps>): SpawnFn {
    if (host.spawner) {
        const transport = makeFdlink(deno as FdlinkDeps);
        const { socketPath, token } = host.spawner;
        return (opts) => udsSpawn(transport, socketPath, token, opts);
    }
    
    // Linux uses Landlock and can safely nest directly. 
    // macOS MUST use the spawner daemon to achieve privilege narrowing.
    if (deno.build.os === "darwin") {
        throw new Error("Security Error: Cannot safely spawn child processes on macOS without a spawner daemon (OS sandboxing cannot be nested).");
    }
    
    return directSpawn(deno);
}
