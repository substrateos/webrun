import { resolve, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { pathToFileURL } from "node:url";
import { printExecutionError, printUsageError } from "../log.ts";
import { WebrunConfig, SandboxContextPayload, HostRuntime, Signal, NetAddr, CommandInvocation, BindingEntry, CommandOptions } from "../types.ts";
import { parseCommandInvocation, parseRawArguments, computeRuntimeEnvironment } from "../config.ts";
import { buildJailConfig, buildRuntimeArgs, buildNetworkFlags, resolveCapabilities } from "../jail.ts";
import type { SandboxPaths } from "../jail.ts";
import type { EnclavePolicy } from "../policy.ts";
import { evaluateEnclavePolicy, findLocalConfigurations, resolveLocalConfiguration, buildNodeSinkholeDependencies, validateSandboxSafetyBoundaries, SecurityViolationError } from "../policy.ts";
import { startImportProxy } from "../import_proxy.ts";
import { BROWSER_USER_AGENT_HASH } from "../constants.ts";
import { tryRealpathSync, tryStatSync, tryRemoveSync, resolveWebrunEntryPath, resolveWebrunCacheRoot } from "../sys.ts";
import { handleCliCommands } from "./cli_commands.ts";
import { setupBindingProcesses } from "./bindings.ts";
import { resolveOpfsStorage } from "./opfs.ts";
import type { MuxProxy } from "../mux.ts";
import { processHtmlTestTargets } from "./html_test.ts";

// =========================================================
// LOCATION CONFIG RESOLUTION
// =========================================================

import type { WebrunLocationConfig, WebrunPermissions } from "../types.ts";

/**
 * Resolves the most specific location config for a given target path.
 * Matches the target against location keys (resolved relative to configDir).
 * Returns the matched WebrunLocationConfig or null if no match.
 */
export function resolveLocationConfig(
    config: WebrunConfig,
    _configDir: string,
    targetPath: string,
): WebrunLocationConfig | null {
    if (!config.locations) return null;
    for (const [locPath, locConfig] of Object.entries(config.locations)) {
        // Location keys are absolute after policy merge (resolveLocalConfiguration).
        const prefix = locPath.endsWith("/") ? locPath : locPath + "/";
        if (targetPath === locPath || targetPath.startsWith(prefix)) {
            return locConfig;
        }
    }
    return null;
}

/**
 * Applies a matched location config onto the root config, returning the
 * effective permissions. Merge semantics:
 *   - permissions: location replaces root (narrowing, not merging)
 *   - limits: location fields override root fields (shallow merge)
 *   - bindings: location entries override root entries (shallow merge)
 *   - importMap: returned for the caller to append to importMapPaths
 *
 * Mutates config.permissions, config.limits, and config.bindings in place.
 * Returns the active permissions for downstream use.
 */
export function applyLocationOverrides(
    config: WebrunConfig,
    location: WebrunLocationConfig,
): { activePerms: WebrunPermissions } {
    let activePerms = config.permissions || {};
    if (location.permissions) {
        activePerms = location.permissions;
        config.permissions = activePerms;
    }
    if (location.limits) {
        config.limits = {
            ...config.limits,
            ...location.limits,
        };
    }
    if (location.bindings) {
        config.bindings = {
            ...config.bindings,
            ...location.bindings,
        };
    }
    return { activePerms };
}

// =========================================================
// HOST: Process lifecycle, binding orchestration, and cleanup
// =========================================================

function terminalStateCapture(sys: HostRuntime): string | null {
    try {
        if (!sys.stdin.isTerminal()) return null;
        const cmd = new sys.Command("stty", { args: ["-g"], stdin: "inherit", stdout: "piped", stderr: "piped" });
        const out = cmd.outputSync();
        if (out.code === 0) return new TextDecoder().decode(out.stdout).trim();
    } catch (_) {}
    return null;
}

/**
 * Captures the current terminal state via stty. Restored after sandbox
 * execution to undo any raw-mode changes the guest script made.
 *
 * Host-side lifecycle only — no counterpart in the browser adapter.
 * The browser has no terminal to save/restore.
 */
function terminalStateRestore(sys: HostRuntime, state: string) {
    try {
        if (!sys.stdin.isTerminal() || !state) return;
        const cmd = new sys.Command("stty", { args: [state], stdin: "inherit", stdout: "piped", stderr: "piped" });
        cmd.outputSync();
    } catch (_) {}
}


async function buildSandboxExecutionConfig(
    sys: HostRuntime,
    invocation: CommandInvocation,
    config: WebrunConfig,
    policy: EnclavePolicy,
    paths: SandboxPaths,
    importMapPath: string,
    MAX_V8_MEM_MB: number | undefined,
    bindingsMap: Record<string, BindingEntry>,
    ephemeralPorts: number[],
    muxPort: number | null,
    spawnToken?: string,
    importProxyPort?: number,
    caCertPath?: string,
): Promise<{ baseCmd: string; cmdOptions: CommandOptions }> {
    const { projectRoot, cwd, isolatedTmp, runnerTmp, opfsTmp, localCacheDir, bindingSdksTmp, webrunEntryPath } = paths;
    const resolveTargetUrl = (p: string) => {
        try { return new URL(p).href; } catch { return pathToFileURL(p).href; }
    };
    let targetUrlHref: string;
    if (invocation.action === "eval") {
        targetUrlHref = `data:application/typescript;charset=utf-8,${encodeURIComponent(invocation.evalCode!)}`;
    } else {
        targetUrlHref = resolveTargetUrl(invocation.targetScriptPath);
    }

    const common = {
        storageRoot: policy.storageRoot,
        fallbackToTemp: policy.fallbackToTemp,
        injectedArgsObj: invocation.injectedArgsObj,
        finalEnvVars: computeRuntimeEnvironment(sys, config.permissions?.env),
        targetUrlHref,
        targetScriptPath: invocation.targetScriptPath,
        sandboxArgs: invocation.sandboxArgs,
        opfsRoot: opfsTmp,
        memoryMB: config.limits?.memoryMB,
        bindingsMap: bindingsMap || {},
        allowedBindings: policy.allowedBindings,
        muxPort: muxPort,
        config,
        configDir: projectRoot,
        runnerTmp,
        spawnToken,
        scriptLocations: invocation.scriptLocations,
        srcdocs: invocation.srcdocs,
    };

    let payloadObject: SandboxContextPayload;
    switch (invocation.action) {
        case "serve":
            payloadObject = { ...common, action: "serve", serveInterfaces: invocation.serveInterfaces! };
            break;
        case "test":
            payloadObject = {
                ...common, action: "test",
                filterPattern: invocation.filterPattern,
                additionalTargetUrls: invocation.additionalTargets?.map((p: string) => resolveTargetUrl(p)),
                additionalTargetPaths: invocation.additionalTargets,
            };
            break;
        case "eval":
            payloadObject = { ...common, action: "eval", evalCode: invocation.evalCode! };
            break;
        case "check-only":
            payloadObject = { ...common, action: "check-only" };
            break;
        case "run":
            payloadObject = { ...common, action: "run" };
            break;
    }

    const jailOs = sys.build.os;

    // payloadPath is a deterministic string — buildRuntimeArgs appends it
    // as a CLI argument but never reads the file.
    const payloadPath = resolve(runnerTmp, "sandbox_payload.json");

    // Resolve capabilities once — all jail backends translate from this.
    const networkFlags = invocation.action === "check-only"
        ? []
        : buildNetworkFlags(invocation.networkFlags, invocation.serveInterfaces, ephemeralPorts);
    const caps = resolveCapabilities(
        sys, policy, paths, ephemeralPorts, !!config.permissions?.gpu,
        jailOs, networkFlags, config.permissions?.env || [],
        // Always include:
        //   - 127.0.0.1: the import proxy runs locally on loopback
        //   - deno.land, jsr.io: WebRun's own vendored imports use these
        //     specifiers, and Deno checks them against --allow-import even
        //     when vendor:true resolves them locally
        ["127.0.0.1", "deno.land", "jsr.io", ...(config.permissions?.import || [])],
    );

    const innerRuntimeArgs = buildRuntimeArgs({
        invocation, maxV8MemMB: MAX_V8_MEM_MB, importMapPath,
        paths, payloadPath, caps, caCertPath,
    });

    const jail = buildJailConfig(
        sys, jailOs, caps, innerRuntimeArgs,
        paths,
        (config.permissions?.network?.length ?? 0) > 0,
    );

    if (jail.landlockPolicy) {
        payloadObject.landlockPolicy = jail.landlockPolicy;
    }
    sys.writeTextFileSync(payloadPath, JSON.stringify(payloadObject));

    const { baseCmd, execArgs } = jail;

    const envVars = { ...payloadObject.finalEnvVars };

    const cmdOptions: CommandOptions = {
        args: execArgs,
        env: {
            ...envVars,
            ...jail.extraEnv,
            "HOME": isolatedTmp,
            "TMPDIR": isolatedTmp,
            "PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
            "USER": "sandbox",
            "DENO_DIR": localCacheDir,
            "TMP_DIR": isolatedTmp,
            ...(importProxyPort ? {
                "HTTP_PROXY": `http://127.0.0.1:${importProxyPort}`,
                "HTTPS_PROXY": `http://127.0.0.1:${importProxyPort}`,
                // Exclude loopback from proxy — mux/binding traffic stays direct.
                "NO_PROXY": "127.0.0.1,localhost",
            } : {}),

            "DENO_NO_UPDATE_CHECK": "1",
        },
        clearEnv: true,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit"
    };

    return { baseCmd, cmdOptions };
}

export async function spawnSandboxProcess(sys: HostRuntime, cwd: string, args: string[]) {
    try {
        await _spawnSandboxProcess(sys, cwd, args);
    } catch (e: any) {
        if (e instanceof SecurityViolationError || e?.name === "SecurityViolationError") {
            sys.exit(1);
            return;
        }
        throw e;
    }
}

async function _spawnSandboxProcess(sys: HostRuntime, cwd: string, args: string[]) {
    // 1a. Parse arguments and resolve configuration BEFORE allocating temp dirs.
    // This lets check-only short-circuit without wasted allocation.
    const argsCopy = args.slice();
    const peekedArgs = parseRawArguments(sys, argsCopy);
    if (peekedArgs.explicitDir) {
        cwd = tryRealpathSync(sys, resolve(cwd, peekedArgs.explicitDir)) || resolve(cwd, peekedArgs.explicitDir);
        args = peekedArgs.sandboxArgs;
    }

    // 1. Setup Stable Paths & Config
    const projectRoot = sys.realPathSync(cwd);
    const localCacheDir = (() => {
        const webrunCache = resolveWebrunCacheRoot(sys.env);

        // Place the Deno module cache under a UA-keyed subdirectory so that
        // changing the browser UA (which causes CDNs like esm.sh to serve
        // different build targets) automatically invalidates stale modules.
        const d = resolve(webrunCache, "modules", BROWSER_USER_AGENT_HASH);
        sys.mkdirSync(d, { recursive: true });
        return sys.realPathSync(d);
    })();

    let configResolveDir = cwd;
    if (!peekedArgs.isEval) {
        let explicitPath = "";
        const positionalArgs: string[] = peekedArgs.injectedArgsObj["--"] || [];
        if (!peekedArgs.isSelfTest && positionalArgs.length > 0 && !positionalArgs[0].startsWith("http") && !positionalArgs[0].startsWith("data:")) {
            explicitPath = positionalArgs[0];
        } else if (peekedArgs.targetScriptPath && peekedArgs.targetScriptPath !== "") {
            explicitPath = peekedArgs.targetScriptPath;
        }

        if (explicitPath) {
            const resolvedPath = tryRealpathSync(sys, explicitPath) || resolve(cwd, explicitPath);
            const stat = tryStatSync(sys, resolvedPath);
            if (stat && stat.isDirectory) {
                configResolveDir = resolvedPath;
            } else {
                configResolveDir = dirname(resolvedPath);
            }
        }
    }
    const { config, configDir, configFound, configPaths, importMapPaths } = resolveLocalConfiguration(sys, configResolveDir);

    await handleCliCommands(sys, args, projectRoot);

    // 2. Parse Routing State
    let invocation: CommandInvocation;
    try {
        invocation = parseCommandInvocation(sys, args, config, configDir);
    } catch (e: any) {
        if (e.message.includes("No execution target")) {
            printUsageError(e.message);
            sys.exit(1);
            return;
        } else {
            throw e;
        }
    }

    // 2a. check-only short circuit — run deno check directly, skip all
    // sandbox machinery (temp dirs, policy, jail, bindings, mux proxy).
    if (invocation.action === "check-only") {
        const cmd = new sys.Command(sys.execPath(), {
            args: ["check", invocation.targetScriptPath],
            stdin: "inherit", stdout: "inherit", stderr: "inherit",
        });
        const status = await cmd.output();
        sys.exit(status.code);
        return;
    }

    // 3. Allocate Ephemeral Paths (skipped for check-only)
    const isolatedTmp = sys.realPathSync(sys.makeTempDirSync({ prefix: 'sandbox_tmp_' }));
    const runnerTmp = sys.realPathSync(sys.makeTempDirSync({ prefix: 'webrun_runner_' }));
    const bindingSdksTmp = sys.realPathSync(sys.makeTempDirSync({ prefix: 'webrun_bindings_' }));

    const { opfsTmp, isEphemeral: isOpfsEphemeral } = resolveOpfsStorage(
        sys, config.experimental?.opfs?.origin, configDir, configPaths, argsCopy
    );

    const MAX_V8_MEM_MB = config.limits?.memoryMB;

    // When the config was discovered via script-path resolution into a
    // subdirectory (configDir is below projectRoot), the sandbox CWD scope
    // should follow the config. When the config is ABOVE the CWD (child
    // process running from a subdirectory), preserve the actual CWD so
    // storage path containment checks work correctly.
    const configBelowCwd = configFound && configDir.startsWith(projectRoot + "/");
    const effectiveCwd = configBelowCwd ? configDir : cwd;

    let activePerms = config.permissions || {};
    const matchedLocation = resolveLocationConfig(config, configDir, invocation.targetScriptPath);
    if (matchedLocation) {
        ({ activePerms } = applyLocationOverrides(config, matchedLocation));
        if (matchedLocation.importMap) {
            // importMap is absolute after policy merge (resolveLocalConfiguration).
            importMapPaths.push(matchedLocation.importMap);
        }
    }

    if (invocation.action === "test" && peekedArgs.isSelfTest) {
        // The self-test harness needs wildcard capabilities to orchestrate tests
        // and spawn sub-processes with various limits.
        activePerms = {
            network: ["*"],
            env: ["*"],
            bindings: ["*"],
            storage: { ".": { access: "read" } }
        };
        config.permissions = activePerms;
    }

    const policy = evaluateEnclavePolicy(sys, activePerms.storage || {}, activePerms.bindings || [], configDir, effectiveCwd, isolatedTmp);

    const protectedFiles: string[] = [...configPaths, ...importMapPaths];

    const binPath = tryRealpathSync(sys, sys.env.get("WEBRUN_BIN") || sys.execPath());
    if (binPath) protectedFiles.push(binPath);

    // Protect the entire source directory — not just this module's subdirectory.
    // sys.ts lives at src/sys.ts, so its dirname gives src/, covering all
    // security-critical modules (guest.ts, policy.ts, jail.ts, config.ts, etc.).
    const srcDir = tryRealpathSync(sys, dirname(new URL(import.meta.resolve("../sys.ts")).pathname));
    if (srcDir) protectedFiles.push(srcDir);

    const allowedWriteEnclaves = [isolatedTmp, ...policy.allowedWritePaths, opfsTmp, bindingSdksTmp];
    policy.allowedReadPaths.push(bindingSdksTmp);

    for (const { dir } of findLocalConfigurations(sys, cwd)) {
        const canonical = tryRealpathSync(sys, dir) || dir;
        protectedFiles.push(canonical);
    }

    validateSandboxSafetyBoundaries(sys, policy, cwd, protectedFiles, allowedWriteEnclaves);

    // Process HTML targets before finalizing the import map.
    // Extracts inline scripts and import maps from .html files, writes
    // them to runnerTmp, and updates invocation targets + importMapPaths.
    // Each extracted script is registered in invocation.scriptLocations with
    // its original HTML file URL and source.
    await processHtmlTestTargets(
        sys, invocation, runnerTmp, importMapPaths,
        activePerms.network || [],
    );

    const importMapPath = buildNodeSinkholeDependencies(sys, isolatedTmp, importMapPaths);

    const runId = crypto.randomUUID();
    const logsDir = resolve(sys.env.get("HOME") || "/tmp", ".webrun", "logs", runId);
    try { sys.mkdirSync(logsDir, { recursive: true }); } catch (_) { }

    const ephemeralPorts: number[] = [];
    // Compile Security Vectors for network interfaces
    if (invocation.serveInterfaces) {
        for (const iface of invocation.serveInterfaces) {
            if (iface.port === 0) {
                try {
                    const l = sys.listen({ port: 0, hostname: "127.0.0.1" });
                    iface.port = (l.addr as NetAddr).port;
                    l.close();
                } catch (_) { }
            }
            ephemeralPorts.push(iface.port);
        }
    }

    const { bindingsMap, activeProcesses, muxProxy, moduleServers, spawnToken } = setupBindingProcesses(sys, config, cwd, configDir, policy, bindingSdksTmp, importMapPath, isolatedTmp, runnerTmp, opfsTmp, logsDir);
    // Only the mux proxy port is exposed to the guest — individual binding
    // ports remain host-side only, strengthening the isolation boundary.
    if (muxProxy) ephemeralPorts.push(muxProxy.port);

    // Start MITM import proxy — intercepts all HTTP/HTTPS traffic via
    // CONNECT tunnels and rewrites User-Agent to a browser-like string.
    // No import map rewrites needed — HTTPS_PROXY routes all traffic.
    const importProxy = await startImportProxy();
    ephemeralPorts.push(importProxy.port);
    moduleServers.push(importProxy);

    // Write the ephemeral CA cert so the sandbox can trust it via --cert.
    const caCertPath = resolve(isolatedTmp, "webrun_ca.pem");
    sys.writeTextFileSync(caCertPath, importProxy.caCertPem);

    // 2.5 Capture Pristine Terminal State
    // Crucial for safely recovering the host terminal if a guest crashes or is forcefully killed
    // while in raw mode, since tcsetattr state escapes the sandbox lifecycle.
    const pristineTtyState = terminalStateCapture(sys);

    // 3. Assemble Process Image
    const webrunEntryPath = resolveWebrunEntryPath(sys, import.meta.url);
    const sandboxPaths: SandboxPaths = {
        projectRoot, cwd, isolatedTmp, runnerTmp, opfsTmp,
        localCacheDir, bindingSdksTmp, webrunEntryPath,
        isSourceMode: webrunEntryPath.endsWith(".ts"),
    };
    const { baseCmd, cmdOptions } = await buildSandboxExecutionConfig(
        sys, invocation, config, policy, sandboxPaths,
        importMapPath, MAX_V8_MEM_MB, bindingsMap, ephemeralPorts,
        muxProxy?.port ?? null, spawnToken, importProxy.port, caCertPath,
    );

    // 4. Run
    await runSandboxLifecycle(
        sys, baseCmd, cmdOptions,
        config.limits?.timeoutMillis, invocation.action === "serve",
        isolatedTmp, runnerTmp, opfsTmp, isOpfsEphemeral, pristineTtyState,
        muxProxy, activeProcesses, moduleServers,
    );
}

/**
 * Spawns the sandbox child process and manages its entire lifecycle:
 * signal forwarding, timeout enforcement, and deterministic cleanup.
 *
 * Completely independent of sandbox configuration — operates only on
 * the pre-built command, timeout limits, and cleanup paths.
 */
async function runSandboxLifecycle(
    sys: HostRuntime,
    baseCmd: string,
    cmdOptions: CommandOptions,
    timeoutMillis: number | undefined,
    isServe: boolean,
    isolatedTmp: string,
    runnerTmp: string,
    opfsTmp: string,
    isOpfsEphemeral: boolean,
    pristineTtyState: string | null,
    muxProxy?: MuxProxy | null,
    activeProcesses: { kill(signal: Signal): void; status: Promise<{ code: number }> }[] = [],
    moduleServers: { shutdown: () => Promise<void> }[] = [],
) {
    const cmd = new sys.Command(baseCmd, cmdOptions);
    let exitCode = 1;

    try {
        const child = cmd.spawn();
        let killed = false;
        let timeoutTimer: number | null = null;
        let timeoutFired = false;

        if (timeoutMillis && !isServe) {
            timeoutTimer = setTimeout(() => {
                timeoutFired = true;
                if (!killed) {
                    killed = true;
                    try { child.kill("SIGKILL"); } catch (_) { }
                }
            }, timeoutMillis);
        }

        const killChild = (sig: Signal) => {
            if (!killed) {
                killed = true;
                try {
                    child.kill(sig);
                } catch (e: any) {
                    // Ignore NotFound if the process already exited natively before we could kill it
                    if (e.name !== "NotFound" && !(e.message && e.message.includes("ESRCH"))) {
                        console.warn(`[Webrun] Warning: Failed to forward ${sig} to sandbox:`, e.message || String(e));
                    }
                }
            }
        };

        const forwardSignal = (sig: Signal) => {
            try {
                child.kill(sig);
            } catch (_) {
                // Process may have already exited
            }
        };

        const onTerm = () => killChild("SIGTERM");
        const onInt = () => killChild("SIGINT");
        const onHup = () => killChild("SIGHUP");
        const onUsr1 = () => forwardSignal("SIGUSR1");
        const onUsr2 = () => forwardSignal("SIGUSR2");

        const tryAddSignal = (sig: Signal, fn: () => void) => {
            try {
                sys.addSignalListener(sig, fn);
            } catch (e: any) {
                if (!e.message?.includes("Not supported")) {
                    console.warn(`[Webrun] Warning: Could not bind ${sig} listener:`, e.message || String(e));
                }
            }
        };

        const tryRemoveSignal = (sig: Signal, fn: () => void) => {
            try {
                sys.removeSignalListener(sig, fn);
            } catch (e: any) {
                if (!e.message?.includes("Not supported")) {
                    console.warn(`[Webrun] Warning: Could not remove ${sig} listener:`, e.message || String(e));
                }
            }
        };

        tryAddSignal("SIGTERM", onTerm);
        tryAddSignal("SIGINT", onInt);
        tryAddSignal("SIGHUP", onHup);
        tryAddSignal("SIGUSR1", onUsr1);
        tryAddSignal("SIGUSR2", onUsr2);

        const status = await child.status;
        if (timeoutTimer) clearTimeout(timeoutTimer);

        tryRemoveSignal("SIGTERM", onTerm);
        tryRemoveSignal("SIGINT", onInt);
        tryRemoveSignal("SIGHUP", onHup);
        tryRemoveSignal("SIGUSR1", onUsr1);
        tryRemoveSignal("SIGUSR2", onUsr2);

        if (timeoutFired) {
            printExecutionError(`Timeout limit reached after ${timeoutMillis}ms`);
            exitCode = 143;
        } else {
            exitCode = status.code;
        }
    } catch (e: any) {
        printExecutionError("Failed to spawn", e.message || String(e));
        exitCode = 1;
    } finally {
        // Kill binding subprocesses and await their termination to prevent
        // orphan accumulation that causes EAGAIN (os error 35) on macOS.
        for (const p of activeProcesses) {
            try { p.kill("SIGTERM"); } catch (_) { }
        }
        // Race each status against a 2s deadline — don't block exit forever.
        const results = await Promise.allSettled(
            activeProcesses.map(p =>
                Promise.race([
                    p.status.then(() => "exited" as const),
                    new Promise<"timeout">(r => setTimeout(() => r("timeout"), 2000))
                ])
            )
        );
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === "fulfilled" && r.value !== "exited") {
                try { activeProcesses[i].kill("SIGKILL"); } catch (_) { }
            }
        }
        if (muxProxy) await muxProxy.shutdown().catch(() => {});
        for (const s of moduleServers) await s.shutdown().catch(() => {});
        tryRemoveSync(sys, isolatedTmp, { recursive: true });
        tryRemoveSync(sys, runnerTmp, { recursive: true });
        if (isOpfsEphemeral) tryRemoveSync(sys, opfsTmp, { recursive: true });
        if (pristineTtyState) terminalStateRestore(sys, pristineTtyState);
    }
    sys.exit(exitCode);
}
