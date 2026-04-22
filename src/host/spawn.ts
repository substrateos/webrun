import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";
import { printExecutionError } from "../log.ts";
import { resolveLocalConfiguration, SecurityViolationError, type EnclavePolicy } from "../policy.ts";
import type { HostRuntime, WebrunConfig } from "../types.ts";

/**
 * Starts the host-side spawn server — a binding behind the mux proxy that
 * accepts child process requests from the guest's ctx.webrun().
 *
 * Protocol: POST with JSON body { args, options }.
 * Response: NDJSON stream of { t: "o"|"e"|"x", c: string|number }.
 *   "o" = stdout chunk, "e" = stderr chunk, "x" = exit code (terminal).
 *
 * The child runs through the full webrun CLI pipeline, getting its own
 * jail, policy, and environment — no permission inheritance from the spawner.
 */
export function startSpawnServer(
    sys: HostRuntime,
    port: number,
    webrunBin: string,
    defaultCwd: string,
    spawnerConfig: WebrunConfig,
    spawnerConfigDir: string,
    spawnerPolicy: EnclavePolicy,
    writableTmpPaths: string[],
): { shutdown: () => Promise<void> } | null {
    // Active children indexed by spawn ID for signal delivery.
    const activeChildren = new Map<string, { kill(sig: string): void }>();

    try {
        const server = sys.serve(
            { port, hostname: "127.0.0.1", onListen: () => {} },
            async (req: Request) => {
                const url = new URL(req.url);

                // Signal endpoint: POST /signal?id=<spawnId>&sig=<signal>
                if (url.pathname === "/signal") {
                    const id = url.searchParams.get("id");
                    const sig = url.searchParams.get("sig") || "SIGTERM";
                    if (id && activeChildren.has(id)) {
                        try { activeChildren.get(id)!.kill(sig); } catch (_) {}
                    }
                    return new Response("ok");
                }

                // Spawn endpoint: POST /spawn
                let body: any;
                try {
                    body = await req.json();
                } catch {
                    return new Response("Bad Request", { status: 400 });
                }

                const args: string[] = body.args || [];
                const opts = body.options || {};
                const cwd = opts.cwdPath || defaultCwd;
                const timeoutMillis = opts.timeoutMillis;

                // Privilege ceiling: the child cannot escalate capabilities
                // beyond the spawner across ALL dimensions.
                try {
                    // CWD: when the guest explicitly provides cwdPath, it must
                    // be within the spawner's already-observable paths. The
                    // defaultCwd (set by the host) is structurally trusted.
                    const spawnerPaths = [
                        ...spawnerPolicy.allowedReadPaths,
                        ...spawnerPolicy.allowedWritePaths,
                        ...writableTmpPaths,
                    ];
                    if (opts.cwdPath) {
                        const canonicalCwd = sys.realPathSync(cwd);
                        if (!spawnerPaths.some(p => canonicalCwd === p || canonicalCwd.startsWith(p + "/"))) {
                            throw new SecurityViolationError(
                                `cwdPath '${cwd}' is outside spawner's allowed paths`
                            );
                        }
                    }

                    const childResolved = resolveLocalConfiguration(sys, cwd);
                    if (childResolved.configFound) {
                        const cc = childResolved.config;
                        const sc = spawnerConfig;

                        // Storage: child's declared storage paths must be
                        // within the spawner's already-allowed paths.
                        if (cc.permissions?.storage) {
                            for (const [relPath, perm] of Object.entries(cc.permissions.storage)) {
                                const absPath = sys.realPathSync(resolve(childResolved.configDir, relPath));
                                const access = (perm as { access: string }).access;
                                if (access === "read" || access === "write") {
                                    const checkPaths = access === "write"
                                        ? [...spawnerPolicy.allowedWritePaths, ...writableTmpPaths]
                                        : spawnerPaths;
                                    if (!checkPaths.some(p => absPath === p || absPath.startsWith(p + "/"))) {
                                        throw new SecurityViolationError(
                                            `Escalating storage ${access}: ${relPath} (${absPath})`
                                        );
                                    }
                                }
                            }
                        }

                        // Env: child env vars must be a subset of parent's
                        // declared env OR explicitly provided via spawn options.
                        const providedEnv = new Set(Object.keys(opts.env || {}));
                        for (const e of cc.permissions?.env || []) {
                            if (!sc.permissions?.env?.includes(e) && !providedEnv.has(e)) {
                                throw new SecurityViolationError(`Escalating env: ${e}`);
                            }
                        }

                        // Network: child network hosts must be a subset
                        for (const n of cc.permissions?.network || []) {
                            if (!sc.permissions?.network?.includes(n)) {
                                throw new SecurityViolationError(`Escalating network: ${n}`);
                            }
                        }

                        // Bindings: child bindings must be a subset
                        for (const b of cc.permissions?.bindings || []) {
                            if (!sc.permissions?.bindings?.includes(b)) {
                                throw new SecurityViolationError(`Escalating binding: ${b}`);
                            }
                        }

                        // Limits: child limits cannot exceed spawner
                        if (sc.limits?.timeoutMillis !== undefined && cc.limits?.timeoutMillis !== undefined
                            && cc.limits.timeoutMillis > sc.limits.timeoutMillis) {
                            throw new SecurityViolationError("Escalating timeoutMillis");
                        }
                        if (sc.limits?.memoryMB !== undefined && cc.limits?.memoryMB !== undefined
                            && cc.limits.memoryMB > sc.limits.memoryMB) {
                            throw new SecurityViolationError("Escalating memoryMB");
                        }
                    }
                } catch (e: any) {
                    if (!(e instanceof SecurityViolationError)) throw e;
                    const enc = new TextEncoder();
                    return new Response(
                        enc.encode(JSON.stringify({ t: "e", c: `[Security] ${e.message}` }) + "\n" +
                                   JSON.stringify({ t: "x", c: 1 }) + "\n"),
                        { headers: { "Content-Type": "application/x-ndjson" } },
                    );
                }

                // Forward requested env vars into the child's OS environment.
                const childEnv: Record<string, string> = {};
                for (const [k, v] of Object.entries(Deno.env.toObject())) {
                    childEnv[k] = v;
                }
                if (opts.env) {
                    for (const [k, v] of Object.entries(opts.env)) {
                        childEnv[k] = String(v);
                    }
                }

                const cmd = new sys.Command(webrunBin, {
                    args,
                    cwd,
                    env: childEnv,
                    stdin: "null",
                    stdout: "piped",
                    stderr: "piped",
                });

                let child: any;
                try {
                    child = cmd.spawn();
                } catch (e: any) {
                    const enc = new TextEncoder();
                    return new Response(
                        enc.encode(JSON.stringify({ t: "e", c: e.message }) + "\n" +
                                   JSON.stringify({ t: "x", c: 1 }) + "\n"),
                        { headers: { "Content-Type": "application/x-ndjson" } },
                    );
                }

                const spawnId = crypto.randomUUID();
                activeChildren.set(spawnId, child);

                const enc = new TextEncoder();
                const stream = new ReadableStream({
                    async start(controller) {
                        const sendLine = (obj: any) => {
                            try { controller.enqueue(enc.encode(JSON.stringify(obj) + "\n")); } catch (_) {}
                        };

                        // Timeout enforcement.
                        let timeoutTimer: number | undefined;
                        let timedOut = false;
                        if (timeoutMillis) {
                            timeoutTimer = setTimeout(() => {
                                timedOut = true;
                                try { child.kill("SIGTERM"); } catch (_) {}
                            }, timeoutMillis);
                        }

                        // Pipe stdout and stderr concurrently.
                        const pipeStream = async (readable: ReadableStream<Uint8Array>, type: string) => {
                            const reader = readable.getReader();
                            const dec = new TextDecoder();
                            try {
                                while (true) {
                                    const { done, value } = await reader.read();
                                    if (done) break;
                                    const text = dec.decode(value, { stream: true });
                                    for (const line of text.split("\n")) {
                                        if (line) sendLine({ t: type, c: line });
                                    }
                                }
                            } catch (_) {}
                        };

                        await Promise.all([
                            pipeStream(child.stdout, "o"),
                            pipeStream(child.stderr, "e"),
                        ]);

                        const status = await child.status;
                        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
                        activeChildren.delete(spawnId);
                        sendLine({ t: "x", c: timedOut ? 143 : status.code });
                        controller.close();
                    },
                });

                // If the guest aborts the fetch, ensure the child is cleaned up.
                req.signal.addEventListener("abort", () => {
                    try { child.kill("SIGTERM"); } catch (_) {}
                    activeChildren.delete(spawnId);
                });

                return new Response(stream, {
                    headers: {
                        "Content-Type": "application/x-ndjson",
                        "X-Spawn-Id": spawnId,
                    },
                });
            },
        );
        return { shutdown: () => server.shutdown() };
    } catch (e: any) {
        printExecutionError(`Failed to start spawn server: ${e.message}`);
        return null;
    }
}
