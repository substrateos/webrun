import { resolve, dirname, isAbsolute } from "https://deno.land/std@0.224.0/path/mod.ts";
import { pathToFileURL } from "node:url";
import { tryRealpathSync, tryStatSync, tryRemoveSync, resolveWebrunEntryPath } from "./sys.ts";
import { printWarning, printExecutionError, printFatalError, printUsageError } from "./log.ts";
import { WebrunConfig, SandboxContextPayload, HostRuntime, Signal, NetAddr, CommandInvocation, BindingEntry, CommandOptions } from "./types.ts";
import { parseCommandInvocation, parseRawArguments, computeRuntimeEnvironment } from "./config.ts";
import { generateSeatbeltEnclaveStrings, generateSeatbeltProfile, buildJailConfig, buildRuntimeArgs } from "./jail.ts";
import type { SandboxPaths } from "./jail.ts";
import type { EnclavePolicy } from "./policy.ts";
import { evaluateEnclavePolicy, findLocalConfigurations, resolveLocalConfiguration, buildNodeSinkholeDependencies, validateSandboxSafetyBoundaries } from "./policy.ts";
import { startMuxProxy } from "./mux.ts";
import type { MuxProxy } from "./mux.ts";

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

function terminalStateRestore(sys: HostRuntime, state: string) {
    try {
        if (!sys.stdin.isTerminal() || !state) return;
        const cmd = new sys.Command("stty", { args: [state], stdin: "inherit", stdout: "piped", stderr: "piped" });
        cmd.outputSync();
    } catch (_) {}
}

function appendTextFileSync(sys: HostRuntime, path: string, data: string) {
    const f = sys.openSync(path, { append: true, create: true, write: true });
    try { f.writeSync(new TextEncoder().encode(data)); } finally { f.close(); }
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
    tokenMap: Record<string, string>,
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

    const payloadObject: SandboxContextPayload = {
        action: invocation.action,
        isSelfTest: invocation.isSelfTest,
        webrunBin: sys.env.get("WEBRUN_BIN") || sys.execPath(),
        isRepackedTest: sys.env.get("WEBRUN_IS_REPACKED_TEST") === "1",
        storageRoot: policy.storageRoot,
        fallbackToTemp: policy.fallbackToTemp,
        injectedArgsObj: invocation.injectedArgsObj,
        finalEnvVars: computeRuntimeEnvironment(sys, config.permissions?.env),
        targetUrlHref,
        targetScriptPath: invocation.targetScriptPath,
        evalCode: invocation.evalCode,
        sandboxArgs: invocation.sandboxArgs,
        opfsRoot: opfsTmp,
        memoryMB: config.limits?.memoryMB,
        bindingsMap: bindingsMap || {},
        allowedBindings: policy.allowedBindings,
        muxPort: muxPort,
        tokenMap: tokenMap,
        serveInterfaces: invocation.serveInterfaces,
        config,
        configDir: projectRoot,
        runnerTmp,
        filterPattern: invocation.filterPattern,
        additionalTargetUrls: invocation.additionalTargets?.map((p: string) => resolveTargetUrl(p)),
        additionalTargetPaths: invocation.additionalTargets,
    };

    // Compute the jail config — the landlockPolicy needs to be
    // serialized into the payload before it's written to disk.
    const jailOs = invocation.isSelfTest ? "none" : sys.build.os;

    // payloadPath is a deterministic string — buildRuntimeArgs appends it
    // as a CLI argument but never reads the file.
    const payloadPath = resolve(runnerTmp, "sandbox_payload.json");

    const innerRuntimeArgs = buildRuntimeArgs(
        sys, invocation, MAX_V8_MEM_MB, importMapPath, ephemeralPorts,
        policy, paths, payloadPath, jailOs
    );

    const jail = buildJailConfig(
        sys, jailOs, policy, innerRuntimeArgs,
        paths, ephemeralPorts, !!config.permissions?.gpu,
        (config.permissions?.network?.length ?? 0) > 0,
    );

    // Attach optionally-present Landlock policy, then write once.
    if (jail.landlockPolicy) {
        payloadObject.landlockPolicy = jail.landlockPolicy;
    }
    sys.writeTextFileSync(payloadPath, JSON.stringify(payloadObject));

    const { baseCmd, execArgs } = jail;

    const envVars = { ...payloadObject.finalEnvVars };
    if (invocation.isSelfTest) {
        if (payloadObject.webrunBin) envVars["WEBRUN_BIN"] = payloadObject.webrunBin;
        envVars["WEBRUN_IS_REPACKED_TEST"] = payloadObject.isRepackedTest ? "1" : "0";
        envVars["WEBRUN_DENO_DIR"] = dirname(sys.execPath());
    }

    const cmdOptions: CommandOptions = {
        args: execArgs,
        env: {
            ...envVars,
            "HOME": isolatedTmp,
            "TMPDIR": isolatedTmp,
            "PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
            "USER": "sandbox",
            "DENO_DIR": localCacheDir,
            "TMP_DIR": isolatedTmp,
            "DENO_TLS_USER_AGENT": `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Webrun/${sys.env.get("WEBRUN_VERSION") || "dev"}`
        },
        clearEnv: true,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit"
    };

    return { baseCmd, cmdOptions };
}

async function handleCliCommands(sys: HostRuntime, args: string[], projectRoot: string) {
    const webrunFlags: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--") break;
        if (!arg.startsWith("-")) break;
        webrunFlags.push(arg);
        if (arg === "--eval" || arg === "-e") break;
        if (arg === "--self-unbundle") {
            if (i + 1 < args.length) webrunFlags.push(args[++i]);
        }
    }

    if (webrunFlags.includes("--version") || webrunFlags.includes("-v")) {
        console.log(`webrun ${sys.env.get("WEBRUN_VERSION") || "dev"}`);
        sys.exit(0);
    }

    const hasSelfTest = webrunFlags.some(f => f === "--self-test" || f.startsWith("--self-test="));
    if (webrunFlags.includes("--self-check") || hasSelfTest) {
        const checkCmd = new sys.Command(sys.execPath(), {
            args: ["check", resolveWebrunEntryPath(sys, import.meta.url)],
            stdout: "inherit",
            stderr: "inherit"
        });
        const status = await checkCmd.output();
        if (status.code !== 0 || !hasSelfTest) {
            sys.exit(status.code);
        }
    }

    if (webrunFlags.includes("--help") || webrunFlags.includes("-h")) {
        try {
            const selfPath = sys.env.get("WEBRUN_BIN") || sys.execPath();
            let readmeContent = sys.readTextFileSync(selfPath);
            const isBundled = !!readmeContent.match(/^__README_DATA__\s*$/m);
            if (isBundled) {
                readmeContent = readmeContent.split(/^__README_DATA__\s*$/m)[1].split(/^__LICENSE_DATA__\s*$/m)[0];
            } else {
                readmeContent = sys.readTextFileSync(resolve(dirname(selfPath), "README.md"));
            }

            const selfCommands = isBundled ?
                `  --self-unbundle <dest>  Extract the webrun source files from the executable into a folder for editing` :
                `  --self-bundle           Package the webrun source files into a single executable file
  --self-vendor           Download all dependencies into the local cache`;

            console.log(`Usage: webrun [options] [args...]

Options:
  -h, --help              Print the usage instructions
  -v, --version           Print the version information
  -e, --eval <code>       Evaluate the given code instead of reading from a file
  --module <name>         Explicitly set the execution entrypoint using a mapped module name
  --test[=<filter>]       Run test suites (with optional name filter)
  --check-only            Perform type checking on the target script without executing it
  --no-check              Skip TypeScript type checking
  --self-test[=<filter>]  Run the built-in test suite (with optional suite filter)
${selfCommands}`);
            const contractMatch = readmeContent.match(/## API[^\n]*\n+([\s\S]*?)(\n## |$)/i);
            if (contractMatch && contractMatch[1]) {
                console.log("==========================================");
                console.log("WEBRUN API CONTRACT");
                console.log("==========================================");
                console.log(contractMatch[1].trim());
            }
        } catch (_) {
            printWarning("Documentation unavailable.");
        }
        sys.exit(0);
    }
}



function setupBindingProcesses(sys: HostRuntime, config: WebrunConfig, cwd: string, configDir: string, policy: EnclavePolicy, bindingSdksTmp: string, importMapPath: string, isolatedTmp: string, runnerTmp: string, opfsTmp: string, logsDir: string) {
    const bindingsMap: Record<string, BindingEntry> = {};
    const activeProcesses: { kill(signal: Signal): void }[] = [];
    const tokenMap: Record<string, string> = {};
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

                let allowedEnv: Record<string, string> = {
                    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
                    "HOME": isolatedTmp,
                    "TMPDIR": isolatedTmp,
                    "TMP_DIR": isolatedTmp,
                    "USER": "sandbox",
                    "DENO_DIR": resolve(sys.env.get("HOME") || "/tmp", ".webrun_cache")
                };
                if (processConfig.permissions?.env) {
                    for (const k of processConfig.permissions.env) allowedEnv[k] = sys.env.get(k) || "";
                } else {
                    allowedEnv = { ...env, ...allowedEnv };
                }

                if (processConfig.portEnv) allowedEnv[processConfig.portEnv] = String(port);
                const cmdExe = processConfig.command[0] === "deno" ? sys.execPath() : processConfig.command[0];
                let resolvedCmdExe = cmdExe;

                let runCmd = resolvedCmdExe;
                let runArgs = processConfig.command.slice(1);

                if (sys.build.os === "darwin") {
                    const processPolicy = evaluateEnclavePolicy(sys, processConfig.permissions?.storage || {}, [], configDir, cwd, isolatedTmp);
                    const webrunEntryPath = resolveWebrunEntryPath(sys, import.meta.url);
                    const { readEnclaves, writeEnclaves } = generateSeatbeltEnclaveStrings(sys, processPolicy, runnerTmp, opfsTmp, bindingSdksTmp, webrunEntryPath);
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
                tokenMap[name] = token;
            } else if (moduleConfig) {
                const absPath = tryRealpathSync(sys, resolve(configDir, moduleConfig as string)) || resolve(configDir, moduleConfig as string);
                bindingsMap[name] = { type: 'module', uuid, path: absPath };
                policy.allowedReadPaths.push(absPath);

                const shimCode = `export default { async fetch(req) { const u = typeof req === 'string' ? new URL(req) : new URL(req.url); const target = "webrun://${name}" + u.pathname + u.search; if (typeof req === 'string') return await fetch(target); const init = { method: req.method, headers: req.headers }; if (req.body && req.method !== 'GET' && req.method !== 'HEAD') { init.body = req.body; } return await fetch(target, init); } };`;
                const shimUrl = `data:application/javascript,${encodeURIComponent(shimCode)}`;

                const importMapPayload = JSON.parse(sys.readTextFileSync(importMapPath));
                importMapPayload.imports = importMapPayload.imports || {};
                importMapPayload.imports[`webrun://${name}`] = shimUrl;
                sys.writeTextFileSync(importMapPath, JSON.stringify(importMapPayload));
            }
        }
    }

    globalThis.addEventListener('unload', () => {
        for (const p of activeProcesses) {
            try { p.kill("SIGTERM"); } catch (_) { }
        }
    });

    // Start mux proxy for process bindings
    const muxProxy = startMuxProxy(sys, muxBindings);

    return { bindingsMap, activeProcesses, muxProxy, tokenMap };
}

/**
 * Computes a deterministic OPFS bucket ID from a canonical directory path.
 * Pure function — base64-encodes the path and strips URL-unsafe characters.
 */
export function computeOpfsPathId(canonicalConfigDir: string): string {
    return btoa(canonicalConfigDir).replace(/[\/+=]/g, "");
}

/**
 * Resolves the OPFS storage directory based on the configured origin strategy.
 *
 * - "git": Derives bucket ID from the repo's root commit hash (shared across clones).
 * - "path": Derives bucket ID from the canonical configDir path (per-directory).
 * - undefined: Ephemeral OPFS — creates a temp dir that is destroyed on exit.
 *
 * Returns the resolved opfsTmp path and whether the storage is ephemeral.
 */
function resolveOpfsStorage(
    sys: HostRuntime,
    opfsOrigin: "git" | "path" | undefined,
    configDir: string,
    configPaths: string[],
    argsCopy: string[],
): { opfsTmp: string; isEphemeral: boolean } {
    if (opfsOrigin !== "git" && opfsOrigin !== "path") {
        return {
            opfsTmp: sys.realPathSync(sys.makeTempDirSync({ prefix: 'webrun_opfs_' })),
            isEphemeral: true,
        };
    }

    let opfsId = "";
    if (opfsOrigin === "git") {
        try {
            const isMac = sys.build.os === "darwin";
            let cmd;
            if (isMac) {
                const canonicalDir = tryRealpathSync(sys, configDir) || configDir;
                const gitJailProfile = `(version 1)
(deny default)
(import "bsd.sb")
(allow file-read-metadata)
(allow file-read*
    (subpath "/usr")
    (subpath "/System")
    (subpath "/Library")
    (subpath "/opt/homebrew")
    (subpath "/private/etc")
    (subpath "/private/var/folders")
    (subpath "/var/folders")
    (subpath "${configDir}")
    (subpath "${canonicalDir}")
)
(allow file-write*
    (regex #"^/private/var/folders/.*/xcrun_db")
    (regex #"^/var/folders/.*/xcrun_db")
)
(allow process-exec
    (literal "/usr/bin/git")
    (literal "/usr/bin/sandbox-exec")
    (literal "/usr/bin/xcrun")
    (subpath "/Library/Developer/CommandLineTools")
)
(allow process-fork)
(allow sysctl-read)
(allow mach-lookup)
(deny network*)
`;
                cmd = new sys.Command("/usr/bin/sandbox-exec", {
                    args: ["-p", gitJailProfile, "/usr/bin/git", "rev-list", "--max-parents=0", "HEAD"],
                    cwd: configDir,
                    stdout: "piped",
                    stderr: "piped",
                    clearEnv: true,
                    env: { "HOME": sys.env.get("HOME") || "/tmp", "PATH": "/usr/bin:/bin" }
                });
            } else {
                cmd = new sys.Command("/usr/bin/git", {
                    args: ["rev-list", "--max-parents=0", "HEAD"],
                    cwd: configDir,
                    stdout: "piped",
                    stderr: "piped",
                    clearEnv: true,
                    env: { "HOME": sys.env.get("HOME") || "/tmp", "PATH": "/usr/bin:/bin" }
                });
            }
            const out = cmd.outputSync();
            if (out.code !== 0) throw new Error("git failed");
            opfsId = new TextDecoder().decode(out.stdout).trim().split("\n")[0];
            if (!opfsId) throw new Error("No git commit");
        } catch (err: any) {
            printFatalError("Configuration Error", "The 'git' OPFS origin strategy requires a valid git repository.");
            sys.exit(1);
        }
    } else {
        const canonicalConfigDir = tryRealpathSync(sys, configDir) || configDir;
        opfsId = computeOpfsPathId(canonicalConfigDir);
    }

    const namespaceDir = resolve(sys.env.get("HOME") || "/tmp", ".webrun", "opfs", opfsOrigin, opfsId);
    let opfsTmp = tryRealpathSync(sys, resolve(namespaceDir, "fs")) || resolve(namespaceDir, "fs");
    try { sys.mkdirSync(opfsTmp, { recursive: true }); } catch (_) { }
    opfsTmp = tryRealpathSync(sys, opfsTmp) || opfsTmp;

    try {
        const auditEntry = JSON.stringify({
            timestamp: new Date().toISOString(),
            configPath: configPaths.length > 0 ? (tryRealpathSync(sys, configPaths[0]) || configPaths[0]) : configDir,
            args: argsCopy
        }) + "\n";
        const auditPath = resolve(namespaceDir, "audit.ndjson");
        appendTextFileSync(sys, auditPath, auditEntry);
    } catch (_) { }

    return { opfsTmp, isEphemeral: false };
}

export async function spawnSandboxProcess(sys: HostRuntime, cwd: string, args: string[]) {
    // 1. Setup Ephemeral Paths & Config
    const projectRoot = sys.realPathSync(cwd);
    const localCacheDir = (() => {
        const d = resolve(sys.env.get("HOME") || "/tmp", ".webrun_cache");
        sys.mkdirSync(d, { recursive: true });
        return sys.realPathSync(d);
    })();
    const isolatedTmp = sys.realPathSync(sys.makeTempDirSync({ prefix: 'sandbox_tmp_' }));
    const runnerTmp = sys.realPathSync(sys.makeTempDirSync({ prefix: 'webrun_runner_' }));
    const bindingSdksTmp = sys.realPathSync(sys.makeTempDirSync({ prefix: 'webrun_bindings_' }));
    const argsCopy = args.slice();
    const peekedArgs = parseRawArguments(sys, argsCopy);
    let configResolveDir = cwd;
    if (!peekedArgs.isEval && !peekedArgs.isSelfTest) {
        let explicitPath = "";
        if (peekedArgs.targetModule && !peekedArgs.targetModule.startsWith("http")) explicitPath = peekedArgs.targetModule;
        else if (peekedArgs.targetScriptPath && peekedArgs.targetScriptPath !== "") explicitPath = peekedArgs.targetScriptPath;

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

    const { opfsTmp, isEphemeral: isOpfsEphemeral } = resolveOpfsStorage(
        sys, config.experimental?.opfs?.origin, configDir, configPaths, argsCopy
    );

    const MAX_V8_MEM_MB = config.limits?.memoryMB;

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
    const policy = evaluateEnclavePolicy(sys, config.permissions?.storage || {}, config.permissions?.bindings || [], configDir, cwd, isolatedTmp);

    const protectedFiles: string[] = [...configPaths, ...importMapPaths];

    const binPath = tryRealpathSync(sys, sys.env.get("WEBRUN_BIN") || sys.execPath());
    if (binPath) protectedFiles.push(binPath);

    // Protect the entire source directory, not just this module.
    // After decomposition, import.meta.url only covers host.ts — but guest.ts,
    // policy.ts, jail.ts, etc. are equally security-critical.
    const selfDir = tryRealpathSync(sys, dirname(new URL(import.meta.url).pathname));
    if (selfDir) protectedFiles.push(selfDir);

    const allowedWriteEnclaves = [isolatedTmp, ...policy.allowedWritePaths, opfsTmp, bindingSdksTmp];
    policy.allowedReadPaths.push(bindingSdksTmp);

    for (const { dir } of findLocalConfigurations(sys, cwd)) {
        const canonical = tryRealpathSync(sys, dir) || dir;
        protectedFiles.push(canonical);
    }

    validateSandboxSafetyBoundaries(sys, policy, cwd, protectedFiles, allowedWriteEnclaves);

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

    const { bindingsMap, activeProcesses, muxProxy, tokenMap } = setupBindingProcesses(sys, config, cwd, configDir, policy, bindingSdksTmp, importMapPath, isolatedTmp, runnerTmp, opfsTmp, logsDir);
    // Only the mux proxy port is exposed to the guest — individual binding
    // ports remain host-side only, strengthening the isolation boundary.
    if (muxProxy) ephemeralPorts.push(muxProxy.port);

    // 2.5 Capture Pristine Terminal State
    // Crucial for safely recovering the host terminal if a guest crashes or is forcefully killed
    // while in raw mode, since tcsetattr state escapes the sandbox lifecycle.
    const pristineTtyState = terminalStateCapture(sys);

    // 3. Assemble Process Image
    const webrunEntryPath = resolveWebrunEntryPath(sys, import.meta.url);
    const sandboxPaths: SandboxPaths = {
        projectRoot, cwd, isolatedTmp, runnerTmp, opfsTmp,
        localCacheDir, bindingSdksTmp, webrunEntryPath,
    };
    const { baseCmd, cmdOptions } = await buildSandboxExecutionConfig(
        sys, invocation, config, policy, sandboxPaths,
        importMapPath, MAX_V8_MEM_MB, bindingsMap, ephemeralPorts,
        muxProxy?.port ?? null, tokenMap,
    );

    // 4. Run
    await runSandboxLifecycle(
        sys, baseCmd, cmdOptions,
        config.limits?.timeoutMillis, invocation.action === "serve",
        isolatedTmp, runnerTmp, opfsTmp, isOpfsEphemeral, pristineTtyState,
        muxProxy,
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
        if (muxProxy) await muxProxy.shutdown().catch(() => {});
        tryRemoveSync(sys, isolatedTmp, { recursive: true });
        tryRemoveSync(sys, runnerTmp, { recursive: true });
        if (isOpfsEphemeral) tryRemoveSync(sys, opfsTmp, { recursive: true });
        if (pristineTtyState) terminalStateRestore(sys, pristineTtyState);
    }
    sys.exit(exitCode);
}
