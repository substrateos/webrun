import type { FSRuntime } from "../../core/file_system/types.ts";
import createFS from "../file_system/mod.ts";
import cli from "../../core/host/cli.ts";
import { findLocalConfigurations, resolveAllAliases, mergeConfigurations } from "../../core/config.ts";
import { parseBundleEnv } from "../../core/bundle.ts";
import type { BundleInfo } from "../../core/bundle.ts";
import { buildRunFn } from "../run/mod.ts";
import { directSpawn } from "../run/spawn.ts";
import type { DenoRuntime } from "../run/deps.ts";
import type { SpawnFn, RunContext } from "../../core/run/types.ts";
import { RunHandle, resolveStoragePaths } from "../../core/types.ts";
import { SharedRegistry } from "../../core/run/shared_registry.ts";

type Signal = "SIGTERM" | "SIGINT" | "SIGHUP" | "SIGUSR1" | "SIGUSR2" | "SIGKILL";

interface HostCtx {
    Deno: FSRuntime & DenoRuntime & {
        exit(code: number): never;
        readTextFile(path: string): Promise<string>;
        readTextFileSync(path: string): string;
        env: { get(key: string): string | undefined };
        addSignalListener(signal: Signal, handler: () => void): void;
        removeSignalListener(signal: Signal, handler: () => void): void;
    };
    ipc: {
        connectSpawner(host: any, deno: any): Promise<SpawnFn>;
    };
}

/**
 * Read the first newline-delimited line from a ReadableStream, parse as JSON.
 * Used by both spawner and proxy to receive startup config.
 */
async function readFirstLine<T>(stdout: ReadableStream<Uint8Array>, label: string): Promise<T> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (let i = 0; i < 200; i++) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`[webrun] ${label} exited before writing config`);
        buffer += decoder.decode(value, { stream: true });
        const newline = buffer.indexOf("\n");
        if (newline !== -1) {
            const line = buffer.slice(0, newline);
            reader.releaseLock();
            return JSON.parse(line) as T;
        }
    }
    throw new Error(`[webrun] ${label} failed to start within timeout`);
}

/**
 * Lazy subprocess manager for the spawner daemon.
 *
 * Spawns the spawner via Deno.Command (unsandboxed — it needs FFI for
 * posix_spawn). Reads config JSON from stdout. Shutdown closes stdin
 * to trigger spawner's parent-death detection.
 */
function lazyImportSpawner(
    deno: HostCtx["Deno"],
    bundle: BundleInfo,
    sockDir: string,
): {
    getSpawner(): Promise<{ socketPath: string; token: string }>;
    shutdown(): Promise<void>;
} {
    let spawner: { socketPath: string; token: string } | null = null;
    let process: { stdin: WritableStream<Uint8Array>; status: Promise<{ code: number }> } | null = null;

    return {
        async getSpawner() {
            if (spawner) return spawner;

            const spawnerSocketPath = `${sockDir}/spawner_${deno.pid}.sock`;
            const spawnerToken = crypto.randomUUID();

            try { deno.mkdirSync(sockDir, { recursive: true }); } catch { /* exists */ }
            try { deno.removeSync(spawnerSocketPath); } catch { /* doesn't exist */ }

            const child = new deno.Command(deno.execPath(), {
                args: [
                    "run", "-A", "--no-check", "--no-config",
                    "--unstable-ffi",
                    bundle.main,
                    "--internal-webrun-spawner",
                    spawnerSocketPath,
                    spawnerToken,
                ],
                stdin: "piped",
                stdout: "piped",
                stderr: "inherit",
            });
            const spawned = child.spawn();

            if (!spawned.stdin || !spawned.stdout) {
                throw new Error("Expected piped stdio for spawner");
            }

            process = { stdin: spawned.stdin, status: spawned.status };

            spawner = await readFirstLine<{ socketPath: string; token: string }>(spawned.stdout, "spawner");
            return spawner;
        },
        async shutdown() {
            if (process) {
                try { await process.stdin.close(); } catch { /* already closed */ }
                try { await process.status; } catch { /* already dead */ }
            }
            if (spawner) {
                try { Deno.removeSync(spawner.socketPath); } catch { /* best effort */ }
            }
        },
    };
}

/**
 * Lazy subprocess manager for the UA proxy.
 *
 * Spawns the proxy as a webrun module via buildRunFn. The proxy
 * writes config JSON to stdout on startup. Shutdown sends SIGTERM.
 */
function lazyImportProxy(
    run: (args: string[], opts?: any) => Promise<RunHandle>,
    deno: HostCtx["Deno"],
    bundle: BundleInfo,
): {
    getProxy(): Promise<{ url: string; noProxy: string[]; caCertPath: string }>;
    shutdown(): Promise<void>;
} {
    let proxy: { url: string; noProxy: string[]; caCertPath: string } | null = null;
    let handle: import("../../core/types.ts").RunHandle | null = null;

    return {
        async getProxy() {
            if (proxy) return proxy;

            const proxyArgs = [bundle.main, "--internal-webrun-proxy"];
            const proxyEnv: Record<string, string> = {};
            for (const [k, v] of Object.entries(Deno.env.toObject())) {
                if (k.startsWith("WEBRUN_")) proxyEnv[k] = v;
            }
            handle = await run(proxyArgs, {
                stdin: new ReadableStream({ start(c) { /* keep open */ } }),
                permissions: { tcp: true, network: ["*"], env: Object.keys(proxyEnv) },
                env: proxyEnv,
            });

            // Pipe stderr to host for diagnostics.
            handle.stderr.pipeTo(new WritableStream({
                write(chunk) { Deno.stderr.writeSync(chunk); },
            })).catch(() => { });

            const parsed = await readFirstLine<{ port: number; caCertPem: string }>(handle.stdout, "UA proxy");
            handle.stdout.cancel().catch(() => {});
            const configDir = deno.makeTempDirSync({ prefix: "webrun_proxy_" });
            const caCertPath = `${configDir}/ca.pem`;
            deno.writeTextFileSync(caCertPath, parsed.caCertPem);
            proxy = {
                url: `http://127.0.0.1:${parsed.port}`,
                noProxy: ["127.0.0.1", "localhost"],
                caCertPath,
            };
            return proxy;
        },
        async shutdown() {
            if (handle) {
                handle.signal("SIGTERM");
                await handle.exitCode;
            }
        },
    };
}

export default {
    async main(args: string[], env: Record<string, string>, ctx: HostCtx) {
        const deno = ctx.Deno;
        const { bundle, readReadme } = parseBundleEnv(env, deno.readTextFileSync, deno.execPath());
        const parsed = await cli(args, env, {
            bundle,
            readReadme,
            console,
            exit: deno.exit,
        });

        const fs = createFS(deno);
        const rootHandle = new fs.FileSystemDirectoryHandle("/", "root");
        const cwd = parsed.flags.dir || deno.cwd();
        const dirParts = cwd.split("/").filter(Boolean);

        const configs = await findLocalConfigurations(rootHandle, dirParts);
        if (configs.length === 0) {
            throw new Error(`No webrun.json found in ${cwd}`);
        }

        const webrunHome = env["WEBRUN_HOME"];
        if (!webrunHome) throw new Error("WEBRUN_HOME is required");

        const cacheDir = env["WEBRUN_CACHE_DIR"];
        if (!cacheDir) throw new Error("WEBRUN_CACHE_DIR is required");
        const tempDir = env["WEBRUN_TEMP"];
        if (!tempDir) throw new Error("WEBRUN_TEMP is required");
        const dataDir = env["WEBRUN_DATA_DIR"];
        if (!dataDir) throw new Error("WEBRUN_DATA_DIR is required");
        const sockDir = cacheDir;

        // On macOS, spawn the spawner daemon for sandboxed child spawning.
        // The spawner is an unsandboxed process that spawns children on behalf
        // of sandboxed callers. This is needed because seatbelt restrictions
        // are inherited and sandbox_init can only be called once per process.
        const spawnerHandle = deno.build.os === "darwin"
            ? lazyImportSpawner(deno, bundle, sockDir)
            : null;
        const spawner = spawnerHandle ? await spawnerHandle.getSpawner() : undefined;

        const sharedRegistry = new SharedRegistry();

        const makeDeps = async (proxy?: { url: string; noProxy: string[]; caCertPath: string }) => {
            const hostPath = env["PATH"] || "";
            const host = { bundle, spawner, proxy, hostPath };
            return {
                Deno: deno,
                fs,
                tempDir,
                cacheDir,
                dataDir,
                spawn: await ctx.ipc.connectSpawner(host, deno),
                host,
                sharedRegistry,
                hostPath,
            };
        };

        // Pre-resolve caller scope from config chain.
        const getPath = (h: FileSystemDirectoryHandle | FileSystemFileHandle): string => {
            const p = fs.resolveHandle(h);
            if (!p) throw new Error("Unrecognized handle: cannot extract path");
            return p;
        };
        const merged = mergeConfigurations(configs, getPath);
        const configDir = getPath(merged.dir);
        const mergedConfig = { ...merged.config };
        if (mergedConfig.permissions?.storage) {
            mergedConfig.permissions = {
                ...mergedConfig.permissions,
                storage: resolveStoragePaths(mergedConfig.permissions.storage, configDir),
            };
        }
        const context: RunContext = {
            aliases: resolveAllAliases(configs, getPath),
            config: mergedConfig,
            protectedPaths: merged.protectedFiles.map(f => getPath(f)),
            importMap: merged.importMap,
            dir: cwd,
        };

        // The proxy needs node:tls (CONNECT tunnels) which requires Deno
        // globals unavailable in the Worker sandbox. Spawn it as a direct
        // Deno subprocess via --internal-webrun-proxy.
        const spawn = directSpawn(deno);
        const proxyRun = async (args: string[], opts?: any): Promise<RunHandle> => {
            const child = await spawn({
                command: deno.execPath(),
                args: ["run", "-A", "--no-check", "--no-config", ...args],
                pipeStdin: true,
                env: opts?.env,
            });
            if (opts?.stdin && child.stdin) {
                opts.stdin.pipeTo(child.stdin).catch(() => {});
            } else if (child.stdin) {
                child.stdin.close().catch(() => {});
            }
            return {
                exitCode: child.exitCode,
                stdout: child.stdout,
                stderr: child.stderr,
                signal(sig: string) { child.kill(sig); },
                urls: Promise.resolve([]),
            };
        };
        const proxyHandle = lazyImportProxy(proxyRun, deno, bundle);
        const proxyConfig = await proxyHandle.getProxy();

        // Build the final run with proxy config for user sandboxes.
        const run = buildRunFn(await makeDeps(proxyConfig), context);

        // --check-only rewrites target to @check: `webrun --check-only file.ts` → `@check file.ts`
        const target = parsed.flags["check-only"] ? "@check" : parsed.target;
        const runArgs = parsed.flags["check-only"]
            ? [target, parsed.target, ...parsed.guestArgs]
            : [target, ...parsed.guestArgs];
        if (parsed.flags.test !== undefined) {
            const val = parsed.flags.test === true ? "" : `=${parsed.flags.test}`;
            runArgs.push(`--test${val}`);
        }

        const signalHandlers: [Signal, () => void][] = [];

        const handle = await run(runArgs, {
            dir: cwd,
            env,
            serve: parsed.serveUrls || [],
            limits: parsed.limits,
        });
        const stdoutDone = handle.stdout.pipeTo(deno.stdout.writable, { preventClose: true }).catch((e: unknown) => console.warn("[webrun] stdout pipe error:", e));
        const stderrDone = handle.stderr.pipeTo(deno.stderr.writable, { preventClose: true }).catch((e: unknown) => console.warn("[webrun] stderr pipe error:", e));

        // Wire OS signals to handle.signal() — replaces the old AbortController pattern.
        const signalForward = (sig: Signal) => {
            const handler = () => handle.signal(sig);
            try {
                deno.addSignalListener(sig, handler);
                signalHandlers.push([sig, handler]);
            } catch { /* signal not supported on this platform */ }
        };
        signalForward("SIGTERM");
        signalForward("SIGINT");
        signalForward("SIGHUP");
        signalForward("SIGUSR1");
        signalForward("SIGUSR2");

        const handleEnd = async () => {
            try { await handle.exitCode; } catch { /* ignore */ }
            for (const [sig, handler] of signalHandlers) deno.removeSignalListener(sig, handler);
            await Promise.all([stdoutDone, stderrDone]);
            if (spawnerHandle) await spawnerHandle.shutdown();
            await proxyHandle.shutdown();
        };

        const exitCode = await handle.exitCode;
        await handleEnd();
        deno.exit(exitCode);
    },
};
