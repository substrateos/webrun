/**
 * Spawner — spawns child processes on behalf of sandboxed callers.
 *
 * - Listens on a Unix domain socket at <socket-path> (via FFI)
 * - Authenticates requests with <token> (constant-time comparison)
 * - Receives pipe ends via SCM_RIGHTS, spawns children with those as stdio
 * - Reports exit codes via proxied child handles
 * - Exits when stdin closes (parent death detection)
 *
 * This module has no dependencies on the rest of webrun.
 */

import { makeFdlink, getFd } from "../../core/fdlink/mod.ts";
import type { FdlinkDeps, Connection, TransferHandle } from "../../core/fdlink/mod.ts";
import { expose, proxy, JSONStream } from "../../core/fdlink/rpc.ts";
import { makeProcess } from "./process.ts";
import type { ProcessDeps } from "./process.ts";
import { timingSafeEqual } from "./protocol.ts";



interface SpawnerDeno extends FdlinkDeps, ProcessDeps {
    stdin: { read(buf: Uint8Array): Promise<number | null> };
    exit(code: number): never;
}

export default {
    async main(args: string[], _env: Record<string, string>, ctx: { Deno: SpawnerDeno }) {
        const socketPath = args[0];
        const token = args[1];

        if (!socketPath || !token) {
            console.error("Usage: spawner <socket-path> <token>");
            ctx.Deno.exit(1);
        }

        const deno = ctx.Deno;
        const transport = makeFdlink(deno);
        const proc = makeProcess(deno);
        const children = new Map<number, { kill: (sig: string) => void }>();

        const listener = transport.listen(socketPath);

        // Signal readiness to the host via stdout.
        console.log(JSON.stringify({ socketPath, token }));

        // ─── Parent death detection ───
        let alive = true;
        (async () => {
            const buf = new Uint8Array(1);
            try {
                while ((await deno.stdin.read(buf)) !== null) { /* drain */ }
            } catch { /* stdin closed */ }

            alive = false;
            for (const [_pid, child] of children) {
                try { child.kill("SIGKILL"); } catch { /* already dead */ }
            }
            listener.close();
            deno.exit(0);
        })();

        // ─── Per-connection API ──────────────────────────────────────────

        function makeSpawnerAPI(conn: Connection) {
            return {
                spawn(
                    request: { token: string; command: string; args: string[]; env: Record<string, string>; cwd: string },
                    handles: TransferHandle[],
                ) {
                    if (!timingSafeEqual(request.token, token)) {
                        throw new Error("Invalid token");
                    }
                    if (handles.length !== 3) {
                        throw new Error(`Expected 3 pipe ends, got ${handles.length}`);
                    }

                    const child = proc.spawnWithFds(
                        request.command, request.args, request.env, request.cwd,
                        {
                            stdin: getFd(handles[0] as any),
                            stdout: getFd(handles[1] as any),
                            stderr: getFd(handles[2] as any),
                        },
                    );

                    // Close the spawner's copies — child has its own via dup2.
                    // Without this, the pipe write ends stay open and the
                    // caller's stdout/stderr reads never see EOF.
                    for (const h of handles) h.close();

                    children.set(child.pid, { kill: (sig) => { try { child.kill(sig); } catch { /* already dead */ } } });

                    const exitCode = new Promise<number>((resolve) => {
                        const poll = () => {
                            const code = child.waitNonBlocking();
                            if (code != null) {
                                children.delete(child.pid);
                                resolve(code);
                                return;
                            }
                            setTimeout(poll, 50);
                        };
                        setTimeout(poll, 0);
                    });

                    return proxy({
                        pid: child.pid,
                        exitCode,
                        signal(sig: string) { try { child.kill(sig); } catch { /* already dead */ } },
                    });
                },
            };
        }

        // ─── Async accept loop ───

        while (alive) {
            try {
                const conn = await listener.accept();
                expose(makeSpawnerAPI(conn), new JSONStream(conn));
            } catch {
                if (!alive) break;
                await new Promise(r => setTimeout(r, 10));
            }
        }
    },
};
