import { resolve, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { printExecutionError } from "../log.ts";
import { tryRealpathSync, resolveWebrunEntryPath } from "../sys.ts";
import { generateSeatbeltProfile, resolveCapabilities, toSeatbeltEnclaves } from "../jail.ts";
import type { SandboxPaths } from "../jail.ts";
import { evaluateEnclavePolicy } from "../policy.ts";
import type { EnclavePolicy } from "../policy.ts";
import { startMuxProxy } from "../mux.ts";
import type { MuxProxy } from "../mux.ts";
import { startSpawnServer } from "./spawn.ts";
import type { HostRuntime, WebrunConfig, NetAddr, BindingEntry, Signal } from "../types.ts";

export type BindingOrchestration = {
    bindingsMap: Record<string, BindingEntry>;
    activeProcesses: { kill(signal: Signal): void; status: Promise<{ code: number }> }[];
    muxProxy: MuxProxy | null;
    moduleServers: { shutdown: () => Promise<void> }[];
    spawnToken: string;
};

export function setupBindingProcesses(sys: HostRuntime, config: WebrunConfig, cwd: string, configDir: string, policy: EnclavePolicy, bindingSdksTmp: string, importMapPath: string, isolatedTmp: string, runnerTmp: string, opfsTmp: string, logsDir: string): BindingOrchestration {
    const bindingsMap: Record<string, BindingEntry> = {};
    const activeProcesses: { kill(signal: Signal): void; status: Promise<{ code: number }> }[] = [];
    const moduleServers: { shutdown: () => Promise<void> }[] = [];

    const muxBindings: { name: string; port: number; token: string }[] = [];

    if (config.bindings) {
        for (const [name, bindingConfig] of Object.entries(config.bindings)) {
            const uuid = crypto.randomUUID();
            let processConfig = bindingConfig.process;
            let moduleConfig = bindingConfig.module;

            if (processConfig) {
                const l = sys.listen({ port: 0, hostname: "127.0.0.1" });
                const port = (l.addr as NetAddr).port;
                l.close();

                // Generate a per-binding bearer token for mux authentication
                const token = crypto.randomUUID();
                muxBindings.push({ name, port, token });

                const env = { ...sys.env.toObject?.() };
                if (processConfig.portEnv) env[processConfig.portEnv] = String(port);

                let allowedEnv = computeBindingEnv(
                    env,
                    processConfig.permissions?.env,
                    isolatedTmp,
                    resolve(sys.env.get("HOME") || "/tmp", ".webrun_cache"),
                );

                if (processConfig.portEnv) allowedEnv[processConfig.portEnv] = String(port);
                const cmdExe = processConfig.command[0] === "deno" ? sys.execPath() : processConfig.command[0];
                let resolvedCmdExe = cmdExe;

                let runCmd = resolvedCmdExe;
                let runArgs = processConfig.command.slice(1);

                if (sys.build.os === "darwin") {
                    const processPolicy = evaluateEnclavePolicy(sys, processConfig.permissions?.storage || {}, [], configDir, cwd, isolatedTmp);
                    const webrunEntryPath = resolveWebrunEntryPath(sys, import.meta.url);
                    const bindingPaths: SandboxPaths = {
                        projectRoot: cwd, cwd, localCacheDir: resolve(sys.env.get("HOME") || "/tmp", ".webrun_cache"),
                        isolatedTmp, runnerTmp, opfsTmp, bindingSdksTmp,
                        webrunEntryPath, isSourceMode: webrunEntryPath.endsWith(".ts"),
                    };
                    const bindingCaps = resolveCapabilities(sys, processPolicy, bindingPaths, [port], !!processConfig.permissions?.gpu, "darwin", [], []);
                    const { readEnclaves, writeEnclaves } = toSeatbeltEnclaves(bindingCaps);
                    const logPath = resolve(logsDir, `${name}.log`);
                    const localWriteEnclaves = writeEnclaves + `\n    (literal "${logPath}")`;
                    const seatbeltProfile = generateSeatbeltProfile(cwd, readEnclaves, localWriteEnclaves, [port], !!processConfig.permissions?.gpu);
                    const profilePath = resolve(bindingSdksTmp, `${name}_sandbox.sb`);
                    sys.writeTextFileSync(profilePath, seatbeltProfile);
                    runCmd = "/usr/bin/sandbox-exec";
                    runArgs = [
                        "-f", profilePath,
                        "-D", `WEBRUN_EXEC_DIR=${tryRealpathSync(sys, dirname(resolvedCmdExe)) || dirname(resolvedCmdExe)}`,
                        "-D", `WEBRUN_EXEC_PATH=${tryRealpathSync(sys, resolvedCmdExe) || resolvedCmdExe}`,
                        "-D", `WEBRUN_SANDBOX_CACHE=${resolve(sys.env.get("HOME") || "/tmp", ".webrun_cache")}`,
                        "-D", `WEBRUN_ISOLATED_TMP=${isolatedTmp}`,
                        "-D", `WEBRUN_DENO_JSON=${resolve(cwd, "deno.json")}`,
                        "-D", `WEBRUN_DENO_JSONC=${resolve(cwd, "deno.jsonc")}`,
                        "-D", `WEBRUN_DENO_LOCK=${resolve(cwd, "deno.lock")}`,
                        "-D", `WEBRUN_SCRIPT_PATH=${webrunEntryPath}`,
                        cmdExe,
                        ...processConfig.command.slice(1)
                    ];
                }

                const logPath = resolve(logsDir, `${name}.log`);
                const logFile = sys.openSync(logPath, { write: true, create: true, append: true });

                const cmd = new sys.Command(runCmd, {
                    args: runArgs,
                    cwd: cwd,
                    env: allowedEnv,
                    clearEnv: true,
                    stdin: "null",
                    stdout: "piped",
                    stderr: "piped"
                });

                try {
                    const child = cmd.spawn();
                    activeProcesses.push(child);
                    console.error(`\x1b[90m[webrun binding: ${name}]\x1b[0m \x1b[35mStarting service...\x1b[0m`);
                    console.error(`\x1b[90m  └─ Logs: ${logPath}\x1b[0m`);

                    const pipeStream = async (stream: ReadableStream<Uint8Array>) => {
                        try {
                            const reader = stream.getReader();
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                logFile.writeSync(value);
                            }
                        } catch (_) { }
                    };
                    const pipesFinished = Promise.all([pipeStream(child.stdout), pipeStream(child.stderr)]);

                    child.status.then(async (status: { code: number }) => {
                        await pipesFinished.catch(() => { });
                        try { logFile.close(); } catch (_) { }

                        // Ignore expected process disruption codes that occur when WebRun naturally terminates the parent JS context
                        // 130: SIGINT, 137: SIGKILL, 141: SIGPIPE, 143: SIGTERM 
                        const expectedTerminationCodes = [130, 137, 141, 143];
                        if (!expectedTerminationCodes.includes(status.code)) {
                            const exitColor = status.code === 0 ? '\x1b[32m' : '\x1b[31m';
                            const eventName = status.code === 0 ? 'exited gracefully' : 'terminated unexpectedly';
                            console.error(`\x1b[90m[webrun binding: ${name}]\x1b[0m ${exitColor}Service ${eventName} (Code: ${status.code})\x1b[0m`);

                            if (status.code !== 0) {
                                try {
                                    const text = sys.readTextFileSync(logPath);
                                    const lines = text.split('\n').filter(Boolean);
                                    const lastLines = lines.slice(-15);
                                    if (lastLines.length > 0) {
                                        const displayPath = logPath.replace(sys.env.get("HOME") || "", "~");
                                        console.error(`\x1b[90m  │  $ tail -n 15 ${displayPath}\x1b[0m`);
                                        for (const line of lastLines) {
                                            console.error(`\x1b[90m  │ \x1b[0m \x1b[37m${line}\x1b[0m`);
                                        }
                                    }
                                } catch (readErr: any) {
                                    console.error("Failed to read log block:", readErr.message || String(readErr));
                                }
                            }
                        }
                    });
                } catch (e: any) {
                    printExecutionError(`Failed to spawn binding process ${name}: ${e.message}`);
                    sys.exit(1);
                }

                bindingsMap[name] = { type: 'process', uuid, port, token };
            } else if (moduleConfig) {
                const absPath = tryRealpathSync(sys, resolve(configDir, moduleConfig as string)) || resolve(configDir, moduleConfig as string);
                policy.allowedReadPaths.push(absPath);

                // Module bindings run host-side: spin up a Deno.serve that
                // dynamically imports the module and forwards fetch calls.
                // The mux proxy routes guest requests to this server, making
                // module and process bindings indistinguishable from the guest.
                const l = sys.listen({ port: 0, hostname: "127.0.0.1" });
                const port = (l.addr as NetAddr).port;
                l.close();

                const token = crypto.randomUUID();
                muxBindings.push({ name, port, token });

                const moduleUrl = new URL(absPath, "file://").href;
                const server = spawnModuleBindingServer(sys, moduleUrl, port, name);
                if (server) moduleServers.push(server);

                bindingsMap[name] = { type: 'process', uuid, port, token };
            }
        }
    }

    // Register the spawn server — allows the guest's ctx.webrun() to
    // launch child processes through the host with full jail enforcement.
    const spawnToken = crypto.randomUUID();
    const spawnListener = sys.listen({ port: 0, hostname: "127.0.0.1" });
    const spawnPort = (spawnListener.addr as NetAddr).port;
    spawnListener.close();
    muxBindings.push({ name: "__spawn", port: spawnPort, token: spawnToken });

    const webrunBin = sys.env.get("WEBRUN_BIN") || sys.execPath();
    const spawnServer = startSpawnServer(sys, spawnPort, webrunBin, cwd, config, configDir, policy, [runnerTmp, isolatedTmp]);
    if (spawnServer) moduleServers.push(spawnServer);

    // Start mux proxy for all bindings (process, module, and spawn alike)
    const muxProxy = startMuxProxy(sys, muxBindings);

    return { bindingsMap, activeProcesses, muxProxy, moduleServers, spawnToken };
}

/**
 * Spawns a local HTTP server that dynamically imports a module binding
 * and delegates incoming requests to its fetch handler.
 * Returns a server handle for cleanup, or null on bind failure.
 */
function spawnModuleBindingServer(
    sys: { serve: typeof Deno.serve },
    moduleUrl: string,
    port: number,
    name: string,
): { shutdown: () => Promise<void> } | null {
    let handler: ((req: Request) => Response | Promise<Response>) | null = null;
    let loadError: string | null = null;

    // Kick off the dynamic import immediately — requests arriving before
    // it completes get a 503.
    const ready = import(moduleUrl).then((mod) => {
        handler = mod.default?.fetch ?? mod.fetch;
        if (typeof handler !== "function") {
            loadError = `Module binding '${name}' does not export a fetch handler`;
        }
    }).catch((err) => {
        loadError = `Module binding '${name}' failed to load: ${err.message}`;
    });

    try {
        const server = sys.serve(
            { port, hostname: "127.0.0.1", onListen: () => {} },
            async (req: Request) => {
                if (!handler && !loadError) await ready;
                if (loadError) return new Response(loadError, { status: 500 });
                try {
                    return await handler!(req);
                } catch (err: any) {
                    return new Response(err.message || "Internal binding error", { status: 500 });
                }
            },
        );
        return { shutdown: () => server.shutdown() };
    } catch (e: any) {
        printExecutionError(`Failed to start module binding server for '${name}': ${e.message}`);
        return null;
    }
}

/**
 * Computes the environment variables for a binding subprocess.
 *
 * Pure function — no I/O, no side effects.
 *
 * @param hostEnv      Full host environment (sys.env.toObject()).
 * @param declaredEnv  Explicit list of env var names from processConfig.permissions.env, or undefined.
 * @param isolatedTmp  Path to the sandbox's isolated temp directory.
 * @param cacheDir     Path to the local Deno cache directory.
 */
export function computeBindingEnv(
    hostEnv: Record<string, string>,
    declaredEnv: string[] | undefined,
    isolatedTmp: string,
    cacheDir: string,
): Record<string, string> {
    const baseEnv: Record<string, string> = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
        "HOME": isolatedTmp,
        "TMPDIR": isolatedTmp,
        "TMP_DIR": isolatedTmp,
        "USER": "sandbox",
        "DENO_DIR": cacheDir,
        "DENO_NO_UPDATE_CHECK": "1",
    };

    if (declaredEnv) {
        for (const k of declaredEnv) baseEnv[k] = hostEnv[k] || "";
        return baseEnv;
    }

    // No permissions.env declared — return only the sandbox base set.
    return baseEnv;
}
