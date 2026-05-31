import createFS from "../file_system/mod.ts";
import { resolveLocation, resolveLocationChain, mergeConfigurations, findLocalConfigurations, resolveAllAliases, type LocalConfig } from "../../core/config.ts";
import { resolveCapabilities, augmentForJail } from "../../core/capabilities.ts";
import toDenoFlags from "../jail/mod.ts";
import inferMode from "../../core/host/mode.ts";
import type { DenoRuntime } from "./deps.ts";
import type { ContextDescriptor } from "../../core/ipc.ts";
import type { RunHandle, RunOptions } from "../../core/types.ts";
import { securityError, resolveStoragePaths } from "../../core/types.ts";
import validate from "../../core/host/policy.ts";
import { generateBaseImportMap, mergeImportMaps } from "./imports.ts";
import { BROWSER_USER_AGENT_HASH } from "../../core/ua.ts";
import cli from "../../core/host/cli.ts";
import type { SpawnFn } from "./spawn.ts";
import type { RunCeiling, RunContext, HostConfig } from "../../core/run/types.ts";
import { SharedRegistry } from "../../core/run/shared_registry.ts";

export type { RunCeiling, HostConfig };

/** Platform primitives + host state for the run function. */
export interface RunDeps {
    Deno: DenoRuntime;
    fs: ReturnType<typeof createFS>;
    /** Parent directory for ephemeral temp dirs. */
    tempDir: string;
    /** Directory for runtime caches (e.g. Deno module cache). */
    cacheDir: string;
    /** Directory for persistent extension data. */
    dataDir: string;

    /** Spawn a child process. Injected by the caller — hides spawner vs. direct. */
    spawn: SpawnFn;

    /** Host services inherited by children. */
    host: HostConfig;

    /** Shared run registry for process deduplication. */
    sharedRegistry?: SharedRegistry;
}

/** Sentinel thrown by the CLI handler for --help / --version to short-circuit. */
class CliExitSignal {
    constructor(public exitCode: number) { }
}

/**
 * Creates a run function bound to the given deps.
 * The returned function is the single entry point for all execution —
 * both CLI invocation and IPC ctx.run calls.
 *
 * Returns a RunHandle immediately — a live handle to the spawned child.
 *
 * @param context - Pre-resolved caller scope: aliases, config, import map, protected paths.
 * @param locations - Optional config chain for target-specific location overrides.
 * @param ceiling - Security ceiling from parent run. Undefined for the initial CLI invocation.
 */
export function buildRunFn(
    deps: RunDeps,
    context: RunContext,
    ceiling?: RunCeiling,
): (args: string[], options?: Omit<RunOptions, 'dir' | 'signal'> & {
    dir?: string;
    dirRoot?: string;
    dirPath?: string[];
}) => Promise<RunHandle> {
    const { fs, tempDir, cacheDir, dataDir, Deno, host } = deps;

    const canonicalize = (p: string) => {
        try { return Deno.realPathSync(p); } catch { return p; }
    };

    const { bundle } = host;

    /** Extract absolute path from a handle. Asserts the handle is recognized. */
    const getPath = (h: FileSystemDirectoryHandle | FileSystemFileHandle): string => {
        const p = fs.resolveHandle(h);
        if (!p) throw new Error("Unrecognized handle: cannot extract path");
        return p;
    };

    return async function run(args, options = {}): Promise<RunHandle> {

        const enc = new TextEncoder();

        // TransformStream pairs for stdout/stderr — writable side is the producer,
        // readable side is exposed on RunHandle.
        const stdoutPair = new TransformStream<Uint8Array>();
        const stderrPair = new TransformStream<Uint8Array>();
        const stdoutWriter = stdoutPair.writable.getWriter();
        const stderrWriter = stderrPair.writable.getWriter();

        // Deferred exit code — the only remaining deferred promise.
        let resolveExitCode!: (code: number) => void;
        let rejectExitCode!: (err: Error) => void;
        const exitCodePromise = new Promise<number>((res, rej) => { resolveExitCode = res; rejectExitCode = rej; });

        // The child reference, set once spawned. signal() is a no-op before spawn.
        let childRef: { kill(signal?: string): void } | null = null;

        const cliConsole = {
            log: (...a: unknown[]) => {
                const chunk = enc.encode(a.map(String).join(" ") + "\n");
                stdoutWriter.write(chunk);
            },
            error: (...a: unknown[]) => {
                const chunk = enc.encode(a.map(String).join(" ") + "\n");
                stderrWriter.write(chunk);
            },
        };

        let parsed;
        try {
            parsed = await cli(args, {}, {
                bundle,
                console: cliConsole,
                exit: (code) => { throw new CliExitSignal(code); },
            });
        } catch (e) {
            if (e instanceof CliExitSignal) {
                resolveExitCode(e.exitCode);
                stdoutWriter.close();
                stderrWriter.close();
                return {
                    exitCode: exitCodePromise,
                    stdout: stdoutPair.readable,
                    stderr: stderrPair.readable,
                    signal() { },
                    urls: Promise.resolve([]),
                };
            }
            throw e;
        }

        const { target, guestArgs: rawArgs } = parsed;

        // Shared runs must not have guest args (options validated at user boundary).
        if (options.shared && rawArgs.length > 0) {
            throw new TypeError("shared runs must not specify extra args — only the target is allowed");
        }

        // Forward webrun-level flags into guestFlags so they reach the
        // sandbox/worker extensions. The host entry point does the same
        // re-injection (host.ts:257-260).
        if (parsed.flags.test !== undefined) {
            parsed.guestFlags.test = parsed.flags.test;
        }
        if (parsed.flags["check-only"]) {
            parsed.guestFlags["check-only"] = true;
        }

        const cwd = options.dir;

        // Discover configs from child's cwd — same path for CLI and worker.
        // Worker mode: dirRoot/dirPath come from the handle's metadata (scoped to temp dir).
        // CLI mode: fall back to "/" as root with full cwd path.
        const configRoot = options.dirRoot ?? "/";
        const configDir = cwd || context.dir;
        const configPathParts = options.dirPath ?? (configDir ? configDir.split("/").filter(Boolean) : []);
        const rootHandle = new fs.FileSystemDirectoryHandle(configRoot, "root");
        const discoveredConfigs = await findLocalConfigurations(rootHandle, configPathParts);

        // Compute aliases: discovered configs override parent context.
        const aliases = discoveredConfigs.length > 0
            ? resolveAllAliases(discoveredConfigs, getPath)
            : context.aliases;

        // Virtual @-targets: each transform produces the binary command + args.
        const virtualTargets: Record<string, ((args: string[], cwd?: string) => { command: string; args: string[] }) | undefined> = {
            "@check": (args, cwd) => ({
                command: Deno.execPath(),
                args: ["check", ...args.map(a => cwd ? resolveLocation(a, cwd) : a)],
            }),
        };

        let resolved: string | undefined;
        let guestArgs: string[];
        const vt = virtualTargets[target];
        if (vt) {
            const result = vt(rawArgs, cwd);
            resolved = result.command;
            guestArgs = result.args;
        } else {
            guestArgs = rawArgs;
            resolved = aliases[target || "default"]
                ?? (target && cwd ? resolveLocation(target, cwd) : target || undefined);
        }
        const mode = inferMode(resolved || "");

        if (!resolved) {
            throw new Error(
                "No execution target specified.\n" +
                "Provide a location alias, a URL, a file path,\n" +
                "or define a 'default' location natively in your webrun.json file."
            );
        }

        // Shared run registry check: if a live handle exists, return it immediately.
        if (options.shared && deps.sharedRegistry) {
            const key = canonicalize(resolved);
            const existing = deps.sharedRegistry.acquire(key);
            if (existing) {
                return wrapSharedHandle(existing);
            }
        }

        let dir = cwd || context.dir;
        let config: import("../../core/types.ts").WebrunLocationConfig = { permissions: {}, limits: {} };
        let importMap = {};
        let protectedPaths: string[] = [];
        let chain: Awaited<ReturnType<typeof resolveLocationChain>> | undefined;

        let permissionsActivated = false;

        if (discoveredConfigs.length > 0) {
            chain = await resolveLocationChain(resolved, discoveredConfigs, getPath);
            const merged = mergeConfigurations(chain, getPath);
            dir = getPath(merged.dir);
            config = merged.config;
            importMap = merged.importMap;
            protectedPaths = merged.protectedFiles.map(f => getPath(f));
            // P1: the `permissions` field in the target (child) config activates the regime.
            permissionsActivated = "permissions" in chain[0].locationConfig;
        }

        // Merge caller-supplied permissions into the resolved config.
        if (options.permissions) {
            config = {
                ...config,
                permissions: { ...config.permissions, ...options.permissions },
            };
        }

        // Merge caller-supplied import map into the resolved import map.
        if (options.importMap) {
            const callerMap = options.importMap as Record<string, any>;
            const existing = importMap as Record<string, any>;
            importMap = {
                imports: { ...(existing.imports || {}), ...(callerMap.imports || {}) },
                scopes: { ...(existing.scopes || {}), ...(callerMap.scopes || {}) },
            };
        }

        // Merge caller-supplied limits and apply ceiling. Limits always narrow to the most restrictive (minimum).
        const mergeLimits = (a?: import("../../core/types.ts").WebrunLimits, b?: import("../../core/types.ts").WebrunLimits) => {
            if (!a) return b;
            if (!b) return a;
            return {
                ...(a.timeoutMillis || b.timeoutMillis ? { timeoutMillis: Math.min(a.timeoutMillis ?? Infinity, b.timeoutMillis ?? Infinity) } : {}),
                ...(a.memoryMB || b.memoryMB ? { memoryMB: Math.min(a.memoryMB ?? Infinity, b.memoryMB ?? Infinity) } : {}),
            };
        };

        config = {
            ...config,
            limits: mergeLimits(mergeLimits(config.limits, options.limits), ceiling?.limits),
        };

        // Ceiling enforcement: isolate accumulates, permissions validated
        if (ceiling) {
            if (ceiling.isolate.length > 0) {
                const childIsolate = (config as any).isolate || [];
                (config as any).isolate = [...new Set([...ceiling.isolate, ...childIsolate])];
            }
        }

        const tempRoot = canonicalize(Deno.makeTempDirSync({ prefix: "webrun_", dir: tempDir }));

        // ctx.dir: exposed only when the child's own config declares storage.
        // findLocalConfigurations returns child-first (closest), parent-last (outermost).
        const childCfg = chain?.[0]?.locationConfig;
        const childDeclaresStorage = childCfg?.permissions?.storage &&
            Object.keys(childCfg.permissions.storage).length > 0;
        const platformExtensions: Record<string, Record<string, unknown>> = {
            "@webrun/deno/file_system": { extensionsDir: dataDir + "/extensions", tempDir: tempRoot, ...(childDeclaresStorage ? { dir: cwd || dir } : {}) },
            ...(config.limits?.memoryMB ? { "@webrun/deno/memory": {} } : {}),
            "@webrun/deno/navigator": {},
            "@webrun/deno/perf": {},
            "@webrun/deno/serve": {},
            ...(config.permissions?.tcp ? { "@webrun/deno/direct_sockets": {} } : {}),
            ...(config.permissions?.webrtc ? { "@webrun/deno/webrtc": { bundlePath: bundle.webrtcBundlePath } } : {}),
            "@webrun/deno/scrub": {},
            "@webrun/check": {},
            "@webrun/html": {},
            "@webrun/opfs": {},
            "@webrun/test": {},
        };
        config = {
            ...config,
            extensions: {
                ...platformExtensions,
                ...config.extensions,
            },
        };

        const rawServeUrls = parsed.serveUrls.length > 0 ? parsed.serveUrls : (options.serve || []);
        const serve = resolveServeUrls(rawServeUrls, Deno.listen);


        const caps = resolveCapabilities({
            permissions: config.permissions || {},
            bundle,
            mode,
            os: Deno.build.os as "darwin" | "linux",
            serve: serve.ports.map((port, i) => ({ port, host: serve.hosts[i] })),
            dir: cwd || dir,
            tempDir: tempRoot,
            canonicalize,
            permissiveDir: !permissionsActivated ? (cwd || dir) : undefined,
        });

        const violations = validate({
            chain,
            protectedPaths: [...bundle.protectedPaths, ...protectedPaths],
            mode,
            argv: mode === "binary" ? [resolved!, ...guestArgs] : [],
            allowedWritePaths: caps.writePaths.map(p => p.path),
            allowedBinaryPrefixes: vt
                ? [[resolved!], ...resolveBinaryPrefixes(config.permissions?.binaries || [], cwd || dir, canonicalize)]
                : resolveBinaryPrefixes(config.permissions?.binaries || [], cwd || dir, canonicalize),
            resolveDir: getPath,
            canonicalize,
            ceiling,
            targetPermissions: config.permissions,
            targetLimits: config.limits,
        });
        if (violations.length > 0) {
            const formatted = violations.map(v => {
                const parts = [v.message];
                if (v.extras) for (const [k, val] of Object.entries(v.extras)) parts.push(`${k}: ${val}`);
                return parts.join("\n  ");
            }).join("; ");
            throw securityError(formatted, violations[0]);
        }

        // Filter env through permissions
        const allowedEnv: Record<string, string> = {};
        const envPerms = config.permissions?.env || [];
        const sourceEnv = options.env || {};
        if (envPerms.includes("*")) {
            Object.assign(allowedEnv, sourceEnv);
        } else {
            for (const key of envPerms) {
                if (key in sourceEnv) allowedEnv[key] = sourceEnv[key];
            }
        }

        try { Deno.mkdirSync(dataDir, { recursive: true }); } catch { /* already exists */ }

        const denoDir = `${cacheDir}/deno/modules/${BROWSER_USER_AGENT_HASH}`;
        const runtimeEnv: Record<string, string> = {
            DENO_DIR: denoDir,
            DENO_NO_UPDATE_CHECK: "1",
            DENO_NO_PACKAGE_JSON: "1",
            DENO_NO_PROMPT: "1",
        };

        const mainDir = bundle.main.substring(0, bundle.main.lastIndexOf("/")) || "/";
        const bootstrapReadPaths = [
            ...bundle.sourceDirs,
            bundle.binDir,
            denoDir,
        ];
        const { augmented, drop } = augmentForJail(caps, {
            readPaths: bootstrapReadPaths,
            writePaths: [denoDir],
            execPaths: mode === "binary" ? [bundle.execPath, resolved!] : [bundle.execPath],
            outboundSocketPaths: host.spawner ? [host.spawner.socketPath] : [],
            keepFfi: mode === "binary" || !!host.spawner,
        });

        // Extensions persist data in dataDir throughout the process lifetime.
        // Add to augmented (grants the permission) but NOT to drop (keeps it after jail revocation).
        if (!augmented.readPaths.find(p => p.path === dataDir)) augmented.readPaths.push({ path: dataDir, optional: false });
        if (!augmented.writePaths.find(p => p.path === dataDir)) augmented.writePaths.push({ path: dataDir, optional: false });

        // The Worker constructor needs read access to the worker blob after jail revocation.
        // Add to augmented but NOT to drop so the permission persists.
        if (bundle.workerPath) {
            const workerDir = bundle.workerPath.substring(0, bundle.workerPath.lastIndexOf("/")) || "/";
            if (!augmented.readPaths.find(p => p.path === workerDir)) augmented.readPaths.push({ path: workerDir, optional: false });
        }

        // Resolve explicit storage grants from RunArg and options.storage.
        // RunArg grants carry resolvedUrl; explicit grants carry _resolvedPath
        // (pre-resolved by the file_system extension).
        if (options.storage) {
            for (const grant of options.storage as any[]) {
                const url = grant.resolvedUrl || grant._resolvedPath;
                if (!url) continue;
                // Convert file:// URL to path if needed.
                const rawPath = url.startsWith("file://") ? url.slice(7) : url;
                const grantPath = canonicalize(rawPath);
                if (grant.access === "write") {
                    if (!augmented.writePaths.find(p => p.path === grantPath)) augmented.writePaths.push({ path: grantPath, optional: false });
                }
                if (!augmented.readPaths.find(p => p.path === grantPath)) augmented.readPaths.push({ path: grantPath, optional: false });
            }
        }
        const sandboxEnv: Record<string, string> = host.proxy && caps.importHosts.length > 0
            ? {
                HTTP_PROXY: host.proxy.url,
                HTTPS_PROXY: host.proxy.url,
                NO_PROXY: host.proxy.noProxy.join(","),
                DENO_CERT: canonicalize(host.proxy.caCertPath),
            }
            : {};

        // The sandbox needs read access to the CA cert file (DENO_CERT) and
        // TCP connect access to the proxy port for non-import HTTPS through
        // the proxy.
        if (host.proxy && caps.importHosts.length > 0) {
            const proxyUrl = new URL(host.proxy.url);
            const proxyPort = parseInt(proxyUrl.port, 10);
            if (proxyPort && !augmented.localNetworkConnectPorts.includes(proxyPort)) {
                augmented.localNetworkConnectPorts.push(proxyPort);
            }
            const certPath = canonicalize(host.proxy.caCertPath);
            if (!augmented.readPaths.find(p => p.path === certPath)) {
                augmented.readPaths.push({ path: certPath, optional: false });
            }
        }

        const descriptor: ContextDescriptor = {
            caps: augmented,
            drop,
            mode,
            host,
            ...(mode === "binary" ? {
                binary: {
                    command: resolved!,
                    args: guestArgs,
                    env: sandboxEnv,
                },
            } : {
                module: {
                    argv: ["webrun", ...args],
                    args: guestArgs,
                    flags: parsed.guestFlags,
                    env: allowedEnv,
                    config,
                    aliases: context.aliases,
                    protectedPaths,
                    fs: {
                        dir: cwd,
                        extensionsDir: dataDir + "/extensions",
                        tempDir: tempRoot,
                        dataDir,
                        cacheDir,
                    },
                    urls: serve.urls,
                    target: resolved || "",
                    importMap,
                },
            }),
        };

        const im = generateBaseImportMap(bundle.workerPath);
        if (bundle.testAdapterPath) {
            im.imports["@webrun/test"] = `file://${bundle.testAdapterPath}`;
        }
        if (importMap) {
            mergeImportMaps(im, importMap);
        }

        const importMapPath = `${tempRoot}/import_map.json`;
        Deno.writeTextFileSync(importMapPath, JSON.stringify(im));

        const descriptorPath = `${tempRoot}/descriptor.json`;
        Deno.writeTextFileSync(descriptorPath, JSON.stringify(descriptor));

        const childArgs = [
            "run",
            "--no-check", "--no-prompt",
            "--unstable-worker-options", "--unstable-net", "--unstable-ffi",
            "--no-config",
            ...toDenoFlags(augmented),
            `--import-map=${importMapPath}`,
            bundle.main,
            "--internal-webrun-sandbox", descriptorPath,
        ];
        const childEnv: Record<string, string> = {
            ...runtimeEnv,
            ...sandboxEnv,
            // Binary mode + serve: inject the port so the binary knows where to bind.
            // Uses portEnv from location config (e.g. "LLAMA_ARG_PORT"), defaulting to "PORT".
            ...(mode === "binary" && serve.ports.length > 0
                ? { [config.portEnv || "PORT"]: String(serve.ports[0]) } : {}),
        };

        // --- Spawn child process ---


        const handle = await deps.spawn({
            command: Deno.execPath(),
            args: childArgs,
            env: childEnv,
            cwd: tempRoot,
            pipeStdin: !!options.stdin,
        });

        childRef = handle;

        // Pipe child stdout/stderr → TransformStream writable.
        stdoutWriter.releaseLock();
        stderrWriter.releaseLock();

        const stdoutDone = handle.stdout.pipeTo(stdoutPair.writable).catch((e: unknown) => console.error("[webrun] stdout pipe error:", e));
        const stderrDone = handle.stderr.pipeTo(stderrPair.writable, { preventClose: true }).catch((e: unknown) => console.error("[webrun] stderr pipe error:", e));

        // Pipe stdin
        if (options.stdin && handle.stdin) {
            options.stdin.pipeTo(handle.stdin).catch((e: unknown) => console.error("[webrun] stdin pipe error:", e));
        }

        // Timeout enforcement
        const timeoutMillis = config.limits?.timeoutMillis;
        let timeoutFired = false;
        let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

        if (timeoutMillis) {
            timeoutTimer = setTimeout(() => {
                timeoutFired = true;
                handle.kill("SIGKILL");
            }, timeoutMillis);
        }

        // Wait for exit + pipe drain in the background.
        (async () => {
            try {
                const code = await handle.exitCode;

                // Drain remaining stdout/stderr before resolving — prevents
                // the host from calling deno.exit() while pipe data is in flight.
                await Promise.all([stdoutDone, stderrDone]);

                if (timeoutFired) {
                    const writer = stderrPair.writable.getWriter();
                    const msg = `\n[webrun] SecurityError: Execution exceeded timeout constraint (${timeoutMillis}ms)\n`;
                    await writer.write(new TextEncoder().encode(msg));
                    writer.releaseLock();
                }

                if (timeoutTimer) clearTimeout(timeoutTimer);
                try { Deno.removeSync(tempRoot, { recursive: true }); } catch (e: any) { console.error("[webrun] temp cleanup failed:", e); }
                resolveExitCode(timeoutFired ? 143 : (code ?? 1));
            } catch (e: any) {
                rejectExitCode(e);
            } finally {
                const writer = stderrPair.writable.getWriter();
                await writer.close().catch(() => { });
            }
        })();

        const result: RunHandle = {
            exitCode: exitCodePromise,
            stdout: stdoutPair.readable,
            stderr: stderrPair.readable,
            signal(sig: string) {
                if (!childRef) return;
                try { childRef.kill(sig); } catch (e: any) {
                    if (e.name !== "NotFound") console.error("[webrun] signal failed:", e);
                }
            },
            urls: Promise.resolve(serve.urls.map(u => new URL(u))),
        };

        // Register shared runs in the registry for deduplication.
        if (options.shared && deps.sharedRegistry) {
            const key = canonicalize(resolved!);
            deps.sharedRegistry.register(key, result);

            // Pipe stdout/stderr to log files so the child doesn't backpressure.
            const logDir = `${deps.dataDir}/shared-logs`;
            try { Deno.mkdirSync(logDir, { recursive: true }); } catch { /* exists */ }
            const logName = resolved!.replace(/[^a-zA-Z0-9._-]/g, "_");

            const drainToFile = (readable: ReadableStream<Uint8Array>, suffix: string) => {
                const path = `${logDir}/${logName}.${suffix}`;
                const file = Deno.openSync(path, { write: true, create: true, truncate: true });
                readable.pipeTo(file.writable).catch(() => { /* stream closed */ });
            };
            drainToFile(result.stdout, "stdout");
            drainToFile(result.stderr, "stderr");

            return wrapSharedHandle(result);
        }

        return result;
    };
}

// ── Shared handle wrapper ───────────────────────────────────────────────

/**
 * Wrap an internal handle as a service-locator handle for shared runs.
 * Only `urls` and `exitCode` are meaningful. stdout/stderr are empty
 * closed streams, signal() is a no-op.
 */
function wrapSharedHandle(inner: { exitCode: Promise<number>; urls: Promise<URL[]> }): RunHandle {
    // Create immediately-closed empty readable streams.
    const emptyStream = () => {
        const { readable, writable } = new TransformStream<Uint8Array>();
        writable.close();
        return readable;
    };
    return {
        exitCode: inner.exitCode,
        stdout: emptyStream(),
        stderr: emptyStream(),
        signal() { /* no-op: lifecycle is scope-managed */ },
        urls: inner.urls,
    };
}

// ── Serve URL resolution ────────────────────────────────────────────────

interface ServeResolution {
    urls: string[];
    ports: number[];
    hosts: string[];
}

/**
 * Resolve serve URLs: allocate ephemeral ports and generate credentials.
 */
function resolveServeUrls(
    rawUrls: (string | URL)[],
    listen: (opts: { port: number; hostname: string }) => { addr: { port: number }; close(): void },
): ServeResolution {
    const urls: string[] = [];
    const ports: number[] = [];
    const hosts: string[] = [];

    for (const url of rawUrls) {
        const u = new URL(String(url));
        let port = parseInt(u.port) || 0;
        const ephemeral = port === 0;
        if (ephemeral) {
            const listener = listen({ port: 0, hostname: u.hostname });
            port = (listener.addr as any).port;
            listener.close();
        }
        const capUrl = new URL(`http://${u.hostname}:${port}/`);
        if (ephemeral || u.username) {
            capUrl.username = u.username || crypto.randomUUID();
            capUrl.password = u.password || crypto.randomUUID();
        }
        urls.push(capUrl.href);
        ports.push(port);
        hosts.push(u.hostname);
    }

    return { urls, ports, hosts };
}

/**
 * Resolve binary prefix paths: if the first element of a prefix is relative,
 * resolve it against the project dir. This ensures prefix matching works when
 * argv contains the resolved absolute path from resolveLocation.
 */
function resolveBinaryPrefixes(
    prefixes: string[][],
    dir: string,
    canonicalize: (p: string) => string,
): string[][] {
    return prefixes.map(prefix => {
        if (prefix.length === 0) return prefix;
        const head = prefix[0];
        if (head.startsWith("/")) return prefix;
        // Relative path — resolve against dir.
        const resolved = canonicalize(new URL(head, "file://" + dir + "/").pathname);
        return [resolved, ...prefix.slice(1)];
    });
}
