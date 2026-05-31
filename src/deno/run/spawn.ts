/**
 * Spawn abstraction — platform-independent child process handle.
 *
 * Both spawner-backed (macOS) and direct (Deno.Command) spawning
 * conform to the SpawnFn signature and return ProcessHandle.
 */

import type { DenoRuntime } from "./deps.ts";
import type { SpawnOptions, ProcessHandle, SpawnFn } from "../../core/run/types.ts";

export type { SpawnFn };

/** Direct spawn via Deno.Command — used on Linux. */
export function directSpawn(deno: DenoRuntime): SpawnFn {
    return async (opts: SpawnOptions): Promise<ProcessHandle> => {
        const child = new deno.Command(opts.command, {
            args: opts.args,
            cwd: opts.cwd,
            env: opts.env,
            stdin: opts.pipeStdin ? "piped" : "inherit",
            stdout: "piped",
            stderr: "piped",
        }).spawn();

        return {
            stdout: child.stdout!,
            stderr: child.stderr!,
            stdin: opts.pipeStdin ? child.stdin : null,
            exitCode: child.status.then((s: { code: number }) => s.code),
            kill: (sig?: string) => {
                try { child.kill(sig as Deno.Signal); } catch (e: any) {
                    if (e.name !== "NotFound") throw e;
                }
            },
        };
    };
}
