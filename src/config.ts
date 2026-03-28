import { resolve, dirname, join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { tryRealpathSync } from "./sys.ts";
import { printUsageError, printWarning, printExecutionError, printFatalError, printSecurityFatal } from "./log.ts";
import { WebrunConfig, CommandInvocation, SandboxContextPayload, ConfigRuntime, adaptGlobalRuntime } from "./types.ts";
// =========================================================
// 2. PURE: CONFIGURATION & PARSING
// =========================================================

export interface ParsedArgs {
    isTest: boolean;
    isSelfTest: boolean;
    isSelfCheck: boolean;
    isEval: boolean;
    isCheckOnly: boolean;
    isNoCheck: boolean;
    isServe: boolean;
    serveInterfaces: { host: string; port: number }[];
    evalCode: string;
    targetScriptPath: string;
    targetModule: string;
    sandboxArgs: string[];
    injectedArgsObj: Record<string, any>;
    filterPattern: string;
}

export function parseRawArguments(args: string[]): ParsedArgs;
export function parseRawArguments(sys: ConfigRuntime, args: string[]): ParsedArgs;
export function parseRawArguments(sysOrArgs: ConfigRuntime | string[], maybeArgs?: string[]): ParsedArgs {
    const sys = Array.isArray(sysOrArgs) ? adaptGlobalRuntime() : sysOrArgs;
    const args = Array.isArray(sysOrArgs) ? sysOrArgs : maybeArgs!;
    const rawArgs = [...args];
    let isTest = false;
    let isSelfTest = false;
    let isSelfCheck = false;
    let isEval = false;
    let isCheckOnly = false;
    let isNoCheck = false;
    let isServe = false;
    let serveInterfaces: { host: string; port: number }[] = [];
    let evalCode = "";
    let filterPattern = "";

    let targetScriptPath: string = "";
    let targetModule = "";
    const injectedArgsObj: Record<string, any> = { "--": [] };
    let onlyPositional = false;
    let scriptFound = false;

    const evalIdxExt = rawArgs.findIndex(a => a === "--eval" || a === "-e");
    if (evalIdxExt !== -1) {
        if (evalIdxExt + 1 < rawArgs.length && rawArgs[evalIdxExt + 1] !== "--") {
            evalCode = rawArgs[evalIdxExt + 1];
            rawArgs.splice(evalIdxExt, 2);
            isEval = true;
            scriptFound = true;
            targetScriptPath = "[eval]";
        } else {
            printUsageError("Usage: webrun --eval <code> [args...]");
            sys.exit(1);
        }
    }

    const selfTestIdx = rawArgs.findIndex(a => a === "--self-test" || a.startsWith("--self-test="));
    if (selfTestIdx !== -1) {
        isTest = true;
        isSelfTest = true;
        const selfTestArg = rawArgs[selfTestIdx];
        if (selfTestArg.startsWith("--self-test=")) {
            filterPattern = selfTestArg.slice("--self-test=".length);
        }
        rawArgs.splice(selfTestIdx, 1);
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
            if (key === "module") { targetModule = val as string; scriptFound = true; continue; }
            if (key === "serve") {
                isServe = true;
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
        isSelfTest,
        isSelfCheck,
        isEval,
        isCheckOnly,
        isNoCheck,
        isServe,
        serveInterfaces,
        evalCode,
        targetScriptPath: targetScriptPath!,
        targetModule,
        sandboxArgs: rawArgs,
        injectedArgsObj,
        filterPattern
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
    let explicitOverride = false;
    let additionalTargets: string[] | undefined;
    // Unified Help/Version check:
    const isHelpOrVersion = ["help", "h", "version", "v"].some(key => parsed.injectedArgsObj[key]);

    if (!isHelpOrVersion && !parsed.isEval && !parsed.isSelfTest) {
        // Additional future exclusive checks could go here if needed.
    }

    // Self-test: resolve the test harness module relative to this package.
    if (parsed.isSelfTest) {
        const selfUrl = new URL(import.meta.url);
        const testHarnessUrl = selfUrl.pathname.endsWith(".ts")
            ? new URL("../webrun.test.ts", import.meta.url)
            : new URL("./webrun.test.ts", import.meta.url);
        resolvedTarget = testHarnessUrl.protocol === "file:"
            ? testHarnessUrl.pathname
            : testHarnessUrl.href;
        explicitOverride = true;
    }

    if (parsed.targetModule) {
        resolvedTarget = parsed.targetModule;
        explicitOverride = true;
    }

    // In test mode without --module, treat positional args as test module paths.
    if (parsed.isTest && !explicitOverride && !parsed.isSelfTest) {
        const positionalArgs: string[] = parsed.injectedArgsObj["--"] || [];
        if (positionalArgs.length > 0) {
            resolvedTarget = positionalArgs[0];
            explicitOverride = true;
            if (positionalArgs.length > 1) {
                additionalTargets = positionalArgs.slice(1);
            }
            // Clear consumed positional args so they don't leak into user args.
            parsed.injectedArgsObj["--"] = [];
        }
    }

    // Implicit fallback evaluating the nearest webrun.json "module" field
    if (!parsed.isEval && !parsed.isSelfTest && !parsed.isSelfCheck && !isHelpOrVersion) {
        if (parsed.isServe && parsed.serveInterfaces.length === 0) {
            let port = 0;
            const portEnv = computeRuntimeEnvironment(sys, ["PORT"]).PORT;
            if (portEnv && /^\d+$/.test(portEnv)) port = parseInt(portEnv, 10);
            parsed.serveInterfaces.push({ host: "127.0.0.1", port });
        }

        if (!explicitOverride) {
            if (parsed.isServe) {
                if (config.serve) {
                    resolvedTarget = resolve(configDir, config.serve);
                } else if (config.module) {
                    resolvedTarget = resolve(configDir, config.module);
                } else {
                    resolvedTarget = sys.cwd();
                }
            } else if (config.module) {
                resolvedTarget = resolve(configDir, config.module);
            } else {
                throw new Error("No execution target specified.\\nProvide a targeting flag (--module), a positional target,\\nor define a 'module' entrypoint natively in your webrun.json file.");
            }
        }
    }

    // Validate that local file targets exist before booting the sandbox.
    // Skip for URLs, eval, self-test, and directory-based serve targets.
    if (resolvedTarget && !parsed.isEval && !parsed.isSelfTest && !isHelpOrVersion) {
        const isUrl = resolvedTarget.startsWith("http://") || resolvedTarget.startsWith("https://") || resolvedTarget.startsWith("data:");
        if (!isUrl) {
            try {
                const stat = sys.statSync(resolvedTarget);
                if (stat.isDirectory && action !== "serve") {
                    throw new Error(`The specified module '${resolvedTarget}' is a directory, not a file.`);
                }
            } catch (e: any) {
                if (e.message?.includes("No such file")) {
                    throw new Error(`The specified module '${resolvedTarget}' does not exist.`);
                }
                if (e.message?.includes("is a directory")) throw e;
            }
        }
    }

    return {
        action,
        isSelfTest: parsed.isSelfTest,
        targetScriptPath: resolvedTarget,
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

export function generateBaseImportMap(): any {
    const sinkholeURI = "data:text/javascript,export default null; throw new Error('Security Error: Node/NPM modules are blocked.');";

    const contextCode = `
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

let isSet = false;
let __rootUrl = "";
let __parentPayload = null;
let __webrunEntryUrl = "";
let __originalWorker = null;

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
    __rootUrl = ctx.__internalRootUrl || "";
    __parentPayload = ctx.__parentPayload;
    __webrunEntryUrl = ctx.__webrunEntryUrl;
    __originalWorker = ctx.__originalWorker;
}

export async function webrun(spawnArgs, options = {}) {
    if (spawnArgs.includes("--test")) {
        throw new Error("not yet implemented");
    }
    return new Promise((resolve) => {
        const workerCode = \`
            import { executeInsideSandbox, parseCommandInvocation } from "\${__webrunEntryUrl}";
            
            self.onmessage = async (e) => {
                if (e.data.type === "spawn") {
                    const sys = {
                        ...globalThis.Deno,
                        exit: (code) => {
                            self.postMessage({ type: "exit", code });
                            self.close();
                        }
                    };
                    
                    console.log = (...a) => { self.postMessage({ type: "stdout", chunk: a.map(String).join(" ") }); };
                    console.error = (...a) => { self.postMessage({ type: "stderr", chunk: a.map(String).join(" ") }); };
                    
                    try {
                        const childPayload = e.data.payload;
                        const invocation = parseCommandInvocation(childPayload.sandboxArgs, childPayload.config || {}, childPayload.configDir || "");
                        
                        childPayload.injectedArgsObj = invocation.injectedArgsObj;
                        childPayload.action = invocation.action;
                        if (invocation.action === "serve") {
                            childPayload.serveInterfaces = invocation.serveInterfaces;
                        }
                        
                        if (invocation.action === "eval") {
                            childPayload.targetScriptPath = "[eval]";
                            childPayload.targetUrlHref = "data:application/typescript;charset=utf-8," + encodeURIComponent(invocation.evalCode);
                            childPayload.evalCode = invocation.evalCode;
                        } else {
                            childPayload.targetScriptPath = invocation.targetScriptPath || "";
                            childPayload.evalCode = undefined;
                            
                            const rootUrl = childPayload.__internalRootUrl;
                            const resolveUrl = (p) => {
                                try { return new URL(p).href; } catch { return new URL(p, rootUrl).href; }
                            };
                            childPayload.targetUrlHref = resolveUrl(childPayload.targetScriptPath);
                        }
                        
                        await executeInsideSandbox(sys, childPayload);
                    } catch (err) {
                        console.error(err.message || String(err));
                        sys.exit(1);
                    }
                }
            };
        \`;
        
        const blobUrl = URL.createObjectURL(new Blob([workerCode], { type: "application/javascript" }));
        
        const workerOptions = { 
            type: "module", 
            name: "webrun-sub-worker",
            deno: { permissions: "inherit" }
        };
        
        const WorkerConstructor = __originalWorker || Worker;
        const worker = new WorkerConstructor(blobUrl, workerOptions);
        
        let stdout = "";
        let stderr = "";
        
        let timer;
        worker.onmessage = (e) => {
            if (e.data.type === "stdout") stdout += e.data.chunk + "\\n";
            else if (e.data.type === "stderr") stderr += e.data.chunk + "\\n";
            else if (e.data.type === "exit") {
                if (timer) clearTimeout(timer);
                URL.revokeObjectURL(blobUrl);
                resolve({ stdout, stderr, exitCode: e.data.code });
            }
        };
        worker.onerror = (e) => {
            if (timer) clearTimeout(timer);
            URL.revokeObjectURL(blobUrl);
            resolve({ stdout, stderr: stderr + "\\n" + e.message, exitCode: 1 });
        };
        
        if (options.timeoutMillis) {
            timer = setTimeout(() => {
                worker.terminate();
                URL.revokeObjectURL(blobUrl);
                resolve({ stdout, stderr: stderr + "\\nTimeout limit reached", exitCode: 143 });
            }, options.timeoutMillis);
        }
        
        const childPayload = { ...__parentPayload };
        delete (childPayload as any).__udpPort;
        childPayload.__internalRootUrl = __rootUrl;
        
        // webrunBin is inherited from the parent payload.
        childPayload.sandboxArgs = [...spawnArgs];
        if (options.memoryMB) childPayload.memoryMB = options.memoryMB;
        if (options.env) childPayload.finalEnvVars = options.env;
        
        worker.postMessage({ type: "spawn", payload: childPayload });
    });
}
`;
    const contextURI = `data:application/typescript;charset=utf-8,${encodeURIComponent(contextCode)}`;

    // Scope for the pre-compiled webrtc bundle: trusted internal code that
    // needs real Node built-in access via Deno's compat layer.
    const internalScopeUrl = new URL("./internal/", import.meta.url).href;

    // The webrun entry itself (and its parent directory) need access to node
    // builtins because the esbuild bundle inlines werift code that imports them.
    // When running bundled, the entry is a temp .js file — its URL differs from
    // the internal/ scope, so we need to whitelist it separately.
    const selfUrl = import.meta.url;
    const selfDirUrl = new URL("./", import.meta.url).href;

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
        "node:dgram": sinkholeURI,  // dgram stays blocked even for internals
    };

    return {
        imports: {
            "webrun/ctx": contextURI,
            "node:fs": sinkholeURI,
            "node:child_process": sinkholeURI,
            "node:dgram": sinkholeURI,
            "node:net": sinkholeURI,
            "node:os": sinkholeURI,
            "node:path": sinkholeURI,
            "node:vm": sinkholeURI,
        },
        scopes: {
            [internalScopeUrl]: nodePassthrough,
            [selfDirUrl]: nodePassthrough,
            [selfUrl]: nodePassthrough,
        }
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

export function mergeImportMaps(targetMap: any, sourceMap: any): void {
    if (sourceMap.imports) {
        Object.assign(targetMap.imports, sourceMap.imports);
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

