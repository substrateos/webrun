import { resolve, dirname, join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { printUsageError, printWarning, printExecutionError, printFatalError, printSecurityFatal } from "./log.ts";
import { WebrunConfig, CommandInvocation, SandboxContextPayload, ConfigRuntime, adaptGlobalRuntime } from "./types.ts";
// =========================================================
// 2. PURE: CONFIGURATION & PARSING
// =========================================================

export interface ParsedArgs {
    isTest: boolean;
    isEval: boolean;
    isCheckOnly: boolean;
    isNoCheck: boolean;
    isServe: boolean;
    serveInterfaces: { host: string; port: number }[];
    evalCode: string;
    targetScriptPath: string;
    sandboxArgs: string[];
    injectedArgsObj: Record<string, any>;
    filterPattern: string;
    explicitDir?: string;
}

export function parseRawArguments(args: string[]): ParsedArgs;
export function parseRawArguments(sys: ConfigRuntime, args: string[]): ParsedArgs;
export function parseRawArguments(sysOrArgs: ConfigRuntime | string[], maybeArgs?: string[]): ParsedArgs {
    const sys = Array.isArray(sysOrArgs) ? adaptGlobalRuntime() : sysOrArgs;
    const args = Array.isArray(sysOrArgs) ? sysOrArgs : maybeArgs!;
    const rawArgs = [...args];
    let isTest = false;
    let isEval = false;
    let isCheckOnly = false;
    let isNoCheck = false;
    let isServe = false;
    let serveInterfaces: { host: string; port: number }[] = [];
    let evalCode = "";
    let filterPattern = "";
    let explicitDir: string | undefined;

    let targetScriptPath: string = "";
    const injectedArgsObj: Record<string, any> = { "--": [] };
    let onlyPositional = false;

    const evalIdxExt = rawArgs.findIndex(a => a === "--eval" || a === "-e");
    if (evalIdxExt !== -1) {
        if (evalIdxExt + 1 < rawArgs.length && rawArgs[evalIdxExt + 1] !== "--") {
            evalCode = rawArgs[evalIdxExt + 1];
            rawArgs.splice(evalIdxExt, 2);
            isEval = true;
            targetScriptPath = "[eval]";
        } else {
            printUsageError("Usage: webrun --eval <code> [args...]");
            sys.exit(1);
        }
    }


    const testIdx = rawArgs.findIndex(a => a === "--test" || a.startsWith("--test="));
    if (testIdx !== -1) {
        isTest = true;
        const testArg = rawArgs[testIdx];
        if (testArg.startsWith("--test=")) {
            filterPattern = testArg.slice("--test=".length);
        }
        rawArgs.splice(testIdx, 1);
    }

    const checkIdx = rawArgs.indexOf("--check-only");
    if (checkIdx !== -1) {
        isCheckOnly = true;
        rawArgs.splice(checkIdx, 1);
    }

    const noCheckIdx = rawArgs.indexOf("--no-check");
    if (noCheckIdx !== -1) {
        isNoCheck = true;
        rawArgs.splice(noCheckIdx, 1);
    }

    const isHelpOrVersion = rawArgs.some(a => a === "--help" || a === "-h" || a === "--version" || a === "-v");

    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i];
        if (onlyPositional) {
            injectedArgsObj["--"].push(arg);
            continue;
        }
        if (arg === "--") {
            onlyPositional = true;
            continue;
        }
        if (arg.startsWith("-")) {
            let key = arg.replace(/^-+/, "");
            let val: string | boolean = "";
            const eqIdx = key.indexOf("=");
            if (eqIdx !== -1) {
                val = key.slice(eqIdx + 1);
                key = key.slice(0, eqIdx);
            } else if (!["serve"].includes(key) && i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("-") && rawArgs[i + 1] !== "--") {
                val = rawArgs[++i];
            } else {
                val = true;
            }
            // --module is deprecated. It's handled as a positional location argument.
            if (key === "serve") {
                isServe = true;
                continue;
            }
            if (key === "dir") {
                explicitDir = val as string;
                if (!explicitDir || explicitDir === true as any) {
                    printUsageError("Usage: webrun --dir=<path>");
                    sys.exit(1);
                }
                continue;
            }
            if (key === "bind" || key === "listen") {
                isServe = true;
                if (val !== true && val !== "") {
                    const strVal = val as string;
                    let host = "127.0.0.1";
                    let port = 0;
                    if (strVal.startsWith(":")) {
                        port = parseInt(strVal.slice(1), 10);
                    } else if (strVal.includes(":")) {
                        const parts = strVal.split(":");
                        host = parts[0];
                        port = parseInt(parts[1], 10);
                    } else {
                        host = strVal;
                    }
                    serveInterfaces.push({ host, port });
                }
                continue;
            }
            injectedArgsObj[key] = val;
        } else {
            injectedArgsObj["--"].push(arg);
        }
    }

    return {
        isTest,
        isEval,
        isCheckOnly,
        isNoCheck,
        isServe,
        serveInterfaces,
        evalCode,
        targetScriptPath: targetScriptPath!,
        sandboxArgs: rawArgs,
        injectedArgsObj,
        filterPattern,
        explicitDir
    };
}

export function resolveExecutionMode(parsed: ParsedArgs): "run" | "test" | "eval" | "check-only" | "serve" {
    if (parsed.isServe) return "serve";
    if (parsed.isEval) return "eval";
    if (parsed.isTest) return "test";
    if (parsed.isCheckOnly) return "check-only";
    return "run";
}

export function buildNetworkFlags(allowedDomains: string[]): string[] {
    if (allowedDomains.length === 1 && allowedDomains[0] === "*") {
        return ["--allow-net"];
    } else if (allowedDomains.length > 0) {
        return [`--allow-net=${allowedDomains.join(",")}`];
    } else {
        return ["--deny-net"];
    }
}

export function parseCommandInvocation(args: string[], config: WebrunConfig, configDir: string): CommandInvocation;
export function parseCommandInvocation(sys: ConfigRuntime, args: string[], config: WebrunConfig, configDir: string): CommandInvocation;
export function parseCommandInvocation(sysOrArgs: ConfigRuntime | string[], argsOrConfig: string[] | WebrunConfig, configOrDir: WebrunConfig | string, maybeDir?: string): CommandInvocation {
    const sys = Array.isArray(sysOrArgs) ? adaptGlobalRuntime() : sysOrArgs;
    const args = Array.isArray(sysOrArgs) ? sysOrArgs : argsOrConfig as string[];
    const config = Array.isArray(sysOrArgs) ? argsOrConfig as WebrunConfig : configOrDir as WebrunConfig;
    const configDir = Array.isArray(sysOrArgs) ? configOrDir as string : maybeDir!;
    const parsed = parseRawArguments(sys, args);
    const action = resolveExecutionMode(parsed);
    const networkFlags = buildNetworkFlags(config.permissions?.network || []);

    let resolvedTarget = parsed.targetScriptPath;
    let resolvedLocationKey: string | undefined;
    let additionalTargets: string[] | undefined;
    const isHelpOrVersion = ["help", "h", "version", "v"].some(key => parsed.injectedArgsObj[key]);


    const resolveLocation = (loc: string): { target: string, key?: string } => {
        if (config.aliases && config.aliases[loc]) {
            return { target: config.aliases[loc], key: loc };
        }
        if (loc.startsWith("http://") || loc.startsWith("https://") || loc.startsWith("data:") || loc.startsWith("file://")) {
            return { target: loc };
        }
        return { target: resolve(sys.cwd(), loc) };
    };

    if (!parsed.isEval) {
        if (parsed.isServe && parsed.serveInterfaces.length === 0) {
            let port = 0;
            const portEnv = computeRuntimeEnvironment(sys, ["PORT"]).PORT;
            if (portEnv && /^\d+$/.test(portEnv)) port = parseInt(portEnv, 10);
            parsed.serveInterfaces.push({ host: "127.0.0.1", port });
        }

        if (parsed.isTest) {
            const positionalArgs: string[] = parsed.injectedArgsObj["--"] || [];
            if (positionalArgs.length > 0) {
                const firstRes = resolveLocation(positionalArgs[0]);
                resolvedTarget = firstRes.target;
                resolvedLocationKey = firstRes.key;
                if (positionalArgs.length > 1) {
                    additionalTargets = positionalArgs.slice(1).map(l => resolveLocation(l).target);
                }
                parsed.injectedArgsObj["--"] = [];
            } else {
                if (config.aliases && config.aliases["default"]) {
                    const res = resolveLocation("default");
                    resolvedTarget = res.target;
                    resolvedLocationKey = res.key;
                } else if (!isHelpOrVersion) {
                    throw new Error("No test target specified.\nProvide a location, path, or define a 'default' location natively in your webrun.json file.");
                }
            }
        } else {
            const positionalArgs: string[] = parsed.injectedArgsObj["--"] || [];
            if (positionalArgs.length > 0) {
                const locStr = positionalArgs.shift()!;
                const res = resolveLocation(locStr);
                resolvedTarget = res.target;
                resolvedLocationKey = res.key;
            } else {
                if (parsed.isServe) {
                    if (config.serve) {
                        resolvedTarget = resolve(configDir, config.serve);
                    } else if (config.aliases && config.aliases["default"]) {
                        const res = resolveLocation("default");
                        resolvedTarget = res.target;
                        resolvedLocationKey = res.key;
                    } else {
                        resolvedTarget = sys.cwd();
                    }
                } else if (config.aliases && config.aliases["default"]) {
                    const res = resolveLocation("default");
                    resolvedTarget = res.target;
                    resolvedLocationKey = res.key;
                } else if (!isHelpOrVersion) {
                    throw new Error("No execution target specified.\nProvide a location alias, a URL, a file path, or define a 'default' location natively in your webrun.json file.");
                }
            }
        }
    }

    // Validate that local file targets exist before booting the sandbox.
    if (resolvedTarget && !parsed.isEval && !isHelpOrVersion) {
        const isUrl = resolvedTarget.startsWith("http://") || resolvedTarget.startsWith("https://") || resolvedTarget.startsWith("data:") || resolvedTarget.startsWith("file://");
        if (!isUrl) {
            try {
                sys.readTextFileSync(resolvedTarget);
            } catch (e: any) {
                if (e.message?.includes("No such file")) {
                    throw new Error(`The specified target '${resolvedTarget}' does not exist.`);
                }
                if (e.message?.includes("is a directory") && action !== "serve") {
                    throw new Error(`The specified target '${resolvedTarget}' is a directory, not a file.`);
                }
            }
        }
    }

    return {
        action,
        targetScriptPath: resolvedTarget,
        resolvedLocationKey,
        isNoCheck: parsed.isNoCheck,
        evalCode: parsed.evalCode,
        sandboxArgs: parsed.sandboxArgs,
        injectedArgsObj: parsed.injectedArgsObj,
        networkFlags,
        serveInterfaces: parsed.serveInterfaces,
        filterPattern: parsed.filterPattern || undefined,
        additionalTargets
    };
}

export function computeRuntimeEnvironment(sys: ConfigRuntime, allowedEnv: string[] = []): Record<string, string> {
    const finalEnvVars: Record<string, string> = {};
    if (allowedEnv.length === 1 && allowedEnv[0] === "*") {
        // Wildcard: inject all host environment variables.
        const all = sys.env.toObject?.() ?? {};
        for (const [k, v] of Object.entries(all)) {
            finalEnvVars[k] = v as string;
        }
    } else {
        for (const k of allowedEnv) {
            finalEnvVars[k] = sys.env.get(k) || "";
        }
    }
    return finalEnvVars;
}

const SINKHOLE_URI = "data:text/javascript,export default null; throw new Error('Security Error: Node/NPM modules are blocked.');";

const CTX_CODE = `
export let args = [];
export let flags = {};
export let env = {};
export let dir = undefined;
export let command = "";
export let persisted = false;
export let bindings = {};
export let makeTempDir = undefined;
export let upgradeWebSocket = undefined;
export let tty = undefined;
export let exit = undefined;
export let __resolvePath = undefined;

let isSet = false;
let __spawnChild = null;

export function set(ctx) {
    if (isSet) throw new Error("Security Error: webrun/ctx is already initialized");
    isSet = true;
    args = ctx.args || [];
    flags = ctx.flags || {};
    env = ctx.env || {};
    dir = ctx.dir;
    command = ctx.command || {};
    persisted = !!ctx.persisted;
    bindings = ctx.bindings || {};
    makeTempDir = ctx.makeTempDir;
    upgradeWebSocket = ctx.upgradeWebSocket;
    tty = ctx.tty;
    exit = ctx.exit;
    __spawnChild = ctx.__spawnChild || null;
    __resolvePath = ctx.__resolvePath || null;
}

export async function webrun(spawnArgs, options = {}) {
    if (!__spawnChild) {
        throw new Error("webrun: spawn function not available (context not initialized)");
    }

    const enc = new TextEncoder();

    let stdoutWriter;
    let stderrWriter;
    try {
        stdoutWriter = options.stdout ? options.stdout.getWriter() : null;
        stderrWriter = options.stderr ? options.stderr.getWriter() : null;
    } catch (err) {
        throw new Error(\`webrun: cannot acquire stream writer -- stream may already be locked: \${err.message}\`);
    }

    let cwdPath = undefined;
    if (options.cwd) {
        if (typeof options.cwd === "string") {
            cwdPath = options.cwd;
        } else if (typeof __resolvePath === "function") {
            cwdPath = __resolvePath(options.cwd);
        }
    }

    let abortPromise = undefined;
    if (options.signal) {
        if (options.signal.aborted) {
            try { stdoutWriter?.releaseLock(); } catch (_) {}
            try { stderrWriter?.releaseLock(); } catch (_) {}
            return { exitCode: 143 };
        }
        abortPromise = new Promise((resolve) => {
            options.signal.addEventListener("abort", () => resolve(options.signal.reason), { once: true });
        });
    }

    const nl = String.fromCharCode(10);
    const result = await __spawnChild(spawnArgs, {
        memoryMB: options.memoryMB,
        env: options.env,
        cwdPath,
        timeoutMillis: options.timeoutMillis,
        abort: abortPromise,
        onStdout: stdoutWriter ? (chunk) => stdoutWriter.write(new TextEncoder().encode(chunk + nl)) : undefined,
        onStderr: stderrWriter ? (chunk) => stderrWriter.write(new TextEncoder().encode(chunk + nl)) : undefined,
    });

    try { stdoutWriter?.close(); } catch (_) {}
    try { stderrWriter?.close(); } catch (_) {}

    const r = { exitCode: result.exitCode };
    if (!stdoutWriter) r.stdout = result.stdout || "";
    if (!stderrWriter) r.stderr = result.stderr || "";
    return r;
}
`;
const CTX_URI = `data:application/typescript;charset=utf-8,${encodeURIComponent(CTX_CODE)}`;

/** Security imports: maps all node:* builtins to a sinkhole that throws. */
export function buildSinkholeImports(): Record<string, string> {
    return {
        "node:fs": SINKHOLE_URI,
        "node:child_process": SINKHOLE_URI,
        "node:dgram": SINKHOLE_URI,
        "node:net": SINKHOLE_URI,
        "node:os": SINKHOLE_URI,
        "node:path": SINKHOLE_URI,
        "node:vm": SINKHOLE_URI,
    };
}

/** Context module: maps webrun/ctx to the inline data URI. */
export function buildCtxImport(): Record<string, string> {
    return { "webrun/ctx": CTX_URI };
}

/**
 * WebRTC scopes: grants node builtin passthrough to trusted internal code
 * (the pre-compiled werift bundle and the webrun entry itself).
 * CLI-only — browsers use native WebRTC.
 */
export function buildWebRTCScopes(): Record<string, Record<string, string>> {
    const internalScopeUrl = new URL("./internal/", import.meta.url).href;
    const selfUrl = import.meta.url;

    const nodePassthrough: Record<string, string> = {
        "node:net": "node:net",
        "node:os": "node:os",
        "node:fs": "node:fs",
        "node:path": "node:path",
        "node:crypto": "node:crypto",
        "node:events": "node:events",
        "node:timers/promises": "node:timers/promises",
        "node:tls": "node:tls",
        "node:module": "node:module",
        "node:perf_hooks": "node:perf_hooks",
        "node:dgram": SINKHOLE_URI,
    };

    const scopes: Record<string, Record<string, string>> = {
        [internalScopeUrl]: nodePassthrough,
        [selfUrl]: nodePassthrough,
    };

    // In source mode, sibling .ts files under src/ need the passthrough too.
    // In bundled mode, selfDirUrl would be file:///tmp/ which is far too broad
    // and would grant node passthrough to child process targets under /tmp/.
    if (selfUrl.endsWith(".ts")) {
        const selfDirUrl = new URL("./", import.meta.url).href;
        scopes[selfDirUrl] = nodePassthrough;
    }

    return scopes;
}

/**
 * Composes all import map concerns into a single map.
 *
 * WebRTC scopes are always included because they're URL-scoped to trusted
 * internal code (the werift bundle and the webrun entry). In bundled binaries,
 * deno bundle inlines dynamic imports, so the bundle.js top-level node:*
 * imports execute unconditionally — the scopes must be present to prevent
 * the sinkhole from blocking them.
 */
export function generateBaseImportMap(): any {
    return {
        imports: { ...buildSinkholeImports(), ...buildCtxImport() },
        scopes: { ...buildWebRTCScopes() },
    };
}

export function rewriteImportMapPathsToAbsolute(userMap: any, baseDir: string): void {
    const rewriteToAbsolute = (obj: Record<string, string>) => {
        if (!obj) return;
        for (const [key, value] of Object.entries(obj)) {
            if (value.startsWith("./") || value.startsWith("../")) {
                let resolved = "file://" + resolve(baseDir, value);
                if (value.endsWith("/") && !resolved.endsWith("/")) resolved += "/";
                obj[key] = resolved;
            }
        }
    };

    if (userMap.imports) {
        rewriteToAbsolute(userMap.imports);
    }

    if (userMap.scopes) {
        const newScopes: any = {};
        for (const [scopeKey, scopeValue] of Object.entries(userMap.scopes)) {
            rewriteToAbsolute(scopeValue as any);
            let resolvedScopeKey = scopeKey;
            if (scopeKey.startsWith("./") || scopeKey.startsWith("../")) {
                resolvedScopeKey = "file://" + resolve(baseDir, scopeKey);
                if (scopeKey.endsWith("/") && !resolvedScopeKey.endsWith("/")) {
                    resolvedScopeKey += "/";
                }
            }
            newScopes[resolvedScopeKey] = scopeValue;
        }
        userMap.scopes = newScopes;
    }
}

/** Keys that user import maps must never override. */
const PROTECTED_IMPORT_KEYS = new Set([
    ...Object.keys(buildSinkholeImports()),
    ...Object.keys(buildCtxImport()),
]);

export function mergeImportMaps(targetMap: any, sourceMap: any): void {
    if (sourceMap.imports) {
        for (const [key, value] of Object.entries(sourceMap.imports)) {
            if (PROTECTED_IMPORT_KEYS.has(key)) continue;
            targetMap.imports[key] = value;
        }
    }
    if (sourceMap.scopes) {
        for (const [scopeKey, scopeValue] of Object.entries(sourceMap.scopes)) {
            if (!targetMap.scopes[scopeKey]) {
                targetMap.scopes[scopeKey] = {};
            }
            Object.assign(targetMap.scopes[scopeKey], scopeValue);
        }
    }
}

