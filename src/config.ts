import { resolve, dirname, join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { sys, printUsageError, printWarning, printExecutionError, printFatalError, printSecurityFatal, tryRealpathSync } from "./sys.ts";
import { WebrunConfig, CommandInvocation, SandboxContextPayload } from "./types.ts";
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
    evalCode: string;
    targetScriptPath: string | string[];
    sandboxArgs: string[];
    injectedArgsObj: Record<string, any>;
}

export function parseRawArguments(args: string[]): ParsedArgs {
    const rawArgs = [...args];
    let isTest = false;
    let isSelfTest = false;
    let isSelfCheck = false;
    let isEval = false;
    let isCheckOnly = false;
    let isNoCheck = false;
    let evalCode = "";

    let targetScriptPath: string | string[] = "";
    const injectedArgsObj: Record<string, any> = { "--": [] };
    let onlyPositional = false;
    const testPaths: string[] = [];
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

    const selfTestIdx = rawArgs.indexOf("--self-test");
    if (selfTestIdx !== -1) {
        isTest = true;
        isSelfTest = true;
        const testPayload = rawArgs[selfTestIdx + 1];
        if (testPayload && !testPayload.startsWith("-")) {
            testPaths.push(testPayload);
            rawArgs.splice(selfTestIdx, 2);
        } else {
            rawArgs.splice(selfTestIdx, 1);
        }
    }

    const testIdx = rawArgs.indexOf("--test");
    if (testIdx !== -1) {
        isTest = true;
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

    if (rawArgs.length === 0 && !isTest && !isEval && !isCheckOnly && !isSelfCheck && !isSelfTest) {
        printUsageError("Usage: webrun [options] <script.ts> [args...]\\nRun with --help for documentation.");
        sys.exit(1);
    }

    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i];
        if (onlyPositional) {
            if ((isTest || isCheckOnly) && !isSelfTest) {
                testPaths.push(arg);
            } else if (isSelfTest) {
                printSecurityFatal("The --self-test execution mode strictly forbids external file paths.");
                sys.exit(1);
            } else {
                injectedArgsObj["--"].push(arg);
            }
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
            } else if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("-") && rawArgs[i + 1] !== "--") {
                val = rawArgs[++i];
            } else {
                val = true;
            }
            injectedArgsObj[key] = val;
        } else {
            if (!(isTest || isCheckOnly)) {
                if (!scriptFound) {
                    targetScriptPath = arg;
                    scriptFound = true;
                } else {
                    injectedArgsObj["--"].push(arg);
                }
            } else if ((isTest || isCheckOnly) && !isSelfTest) {
                testPaths.push(arg);
                scriptFound = true;
            } else if (isSelfTest) {
                printSecurityFatal("The --self-test execution mode strictly forbids external file paths.");
                sys.exit(1);
            }
        }
    }

    if (isTest || isCheckOnly) {
        if (testPaths.length === 0) {
            printUsageError("Usage: webrun [options] <script1.ts> ...\\nRun with --help for documentation.");
            sys.exit(1);
        }
        targetScriptPath = testPaths;
    } else if (!isEval && !isSelfTest && !isSelfCheck) {
        if (!scriptFound) {
            printUsageError("Usage: webrun [options] <script.ts> [args...]\\nRun with --help for documentation.");
            sys.exit(1);
        }
    }

    return {
        isTest,
        isSelfTest,
        isSelfCheck,
        isEval,
        isCheckOnly,
        isNoCheck,
        evalCode,
        targetScriptPath: targetScriptPath!,
        sandboxArgs: rawArgs,
        injectedArgsObj
    };
}

export function resolveExecutionMode(parsed: ParsedArgs): "run" | "test" | "eval" | "check-only" {
    if (parsed.isEval) return "eval";
    if (parsed.isTest) return "test";
    if (parsed.isCheckOnly) return "check-only";
    return "run";
}

export function buildNetworkFlags(allowedDomains: string[]): string[] {
    const SSRF_BLOCK = "--deny-net=10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,169.254.0.0/16";
    const networkFlags: string[] = [];
    if (allowedDomains.length > 0) {
        networkFlags.push(`--allow-net=${allowedDomains.join(",")}`);
        networkFlags.push(SSRF_BLOCK);
    } else {
        networkFlags.push("--deny-net");
    }
    return networkFlags;
}

export function parseCommandInvocation(args: string[], config: WebrunConfig): CommandInvocation {
    const parsed = parseRawArguments(args);
    const action = resolveExecutionMode(parsed);
    const networkFlags = buildNetworkFlags(config.permissions?.network || []);

    return {
        action,
        isSelfTest: parsed.isSelfTest,
        targetScriptPath: parsed.targetScriptPath,
        isNoCheck: parsed.isNoCheck,
        evalCode: parsed.evalCode,
        sandboxArgs: parsed.sandboxArgs,
        injectedArgsObj: parsed.injectedArgsObj,
        networkFlags
    };
}

export function computeRuntimeEnvironment(allowedEnv: string[] = []): Record<string, string> {
    const finalEnvVars: Record<string, string> = {};
    for (const k of allowedEnv) {
        finalEnvVars[k] = sys.env.get(k) || "";
    }
    return finalEnvVars;
}

export interface EnclavePolicy {
    isPwdAllowed: boolean;
    fallbackToTemp: boolean;
    storageRoot: string;
    allowedReadPaths: string[];
    allowedWritePaths: string[];
    allowedBindings: string[];
}

export function evaluateEnclavePolicy(configDirs: Record<string, { access: "read" | "write" }>, configBindings: string[], configDir: string, currentDir: string, isolatedTmp: string): EnclavePolicy {
    let isPwdAllowed = false;
    const fallbackToTemp = Object.keys(configDirs).length === 0;

    const allowedReadPaths: string[] = [];
    const allowedWritePaths: string[] = [];
    const allowedBindings: string[] = [];

    for (let [fsPath, settings] of Object.entries(configDirs)) {
        if (fsPath.startsWith("~/")) {
            fsPath = (sys.env.get("HOME") || "") + fsPath.slice(1);
        }
        
        const absFsPath = resolve(configDir, fsPath);
        if (currentDir === absFsPath || currentDir.startsWith(absFsPath + "/")) {
            isPwdAllowed = true;
        }

        allowedReadPaths.push(absFsPath);
        if (settings.access === "write") {
            allowedWritePaths.push(absFsPath);
        }
    }

    for (const bindingName of configBindings || []) {
        allowedBindings.push(bindingName);
    }

    if (fallbackToTemp) {
        allowedReadPaths.push(currentDir);
    }

    return {
        isPwdAllowed,
        fallbackToTemp,
        allowedReadPaths,
        allowedWritePaths,
        storageRoot: fallbackToTemp ? isolatedTmp : currentDir,
        allowedBindings
    };
}

export function generateDenoStorageFlags(policy: EnclavePolicy, isolatedTmp: string, runnerTmp: string, opfsTmp: string, bindingSdksTmp: string, webrunEntryPath: string): string[] {
    const unresolvedDir = dirname(webrunEntryPath);
    const selfPath = tryRealpathSync(webrunEntryPath) || webrunEntryPath;
    const r = [isolatedTmp, ...policy.allowedReadPaths, runnerTmp, opfsTmp, selfPath, webrunEntryPath, bindingSdksTmp];
    
    // Only grant read access to the surrounding source directory if running
    // from the raw, unbundled source code (since it needs to dynamically import sibling .ts files).
    // Bundled executables are self-contained and do not need read access to their directory.
    if (webrunEntryPath.endsWith("/src/execution.ts") || webrunEntryPath.endsWith("\\src\\execution.ts")) {
        const selfDir = tryRealpathSync(unresolvedDir) || unresolvedDir;
        r.push(selfDir, unresolvedDir);
    }

    const w = [isolatedTmp, ...policy.allowedWritePaths, opfsTmp];
    return [
        `--allow-read=${r.join(",")}`,
        `--allow-write=${w.join(",")}`
    ];
}

export function generateSeatbeltEnclaveStrings(policy: EnclavePolicy, runnerTmp: string, opfsTmp: string, bindingSdksTmp: string, webrunEntryPath: string): { readEnclaves: string, writeEnclaves: string } {
    let readEnclaves = "";
    let writeEnclaves = "";

    const selfPath = tryRealpathSync(webrunEntryPath) || webrunEntryPath;
    readEnclaves += `\n    (subpath "${selfPath}")`;
    
    // Only grant read access to the surrounding source directory if running
    // from the raw, unbundled source code (since it needs to dynamically import sibling .ts files).
    // Bundled executables are self-contained and do not need read access to their directory.
    if (webrunEntryPath.endsWith("/src/execution.ts") || webrunEntryPath.endsWith("\\src\\execution.ts")) {
        const dirPath = dirname(selfPath);
        readEnclaves += `\n    (subpath "${dirPath}")`;
    }

    for (const p of policy.allowedReadPaths) {
        readEnclaves += `\n    (subpath "${p}")`;
    }
    readEnclaves += `\n    (subpath "${runnerTmp}")`;
    readEnclaves += `\n    (subpath "${bindingSdksTmp}")`;

    for (const p of policy.allowedWritePaths) {
        writeEnclaves += `\n    (subpath "${p}")`;
    }
    writeEnclaves += `\n    (subpath "${opfsTmp}")`;

    return { readEnclaves, writeEnclaves };
}

export function generateSeatbeltProfile(cwd: string, readEnclaves: string, writeEnclaves: string, ephemeralPorts: number[] = [], allowGpu: boolean = false): string {
    let extraNetworkOutbound = "";
    let extraNetworkInbound = "";
    for (const port of ephemeralPorts) {
        extraNetworkOutbound += `\n    (remote tcp "localhost:${port}")`;
        extraNetworkInbound += `\n    (local tcp "*:${port}")\n    (local tcp "localhost:${port}")`;
    }

    let inboundBlock = "";
    if (extraNetworkInbound) {
        inboundBlock = `\n(allow network-inbound${extraNetworkInbound}\n)`;
    }

    return `(version 1)
(deny default)
(import "bsd.sb")
(allow file-read-metadata)
(allow signal)
(allow system-fsctl)
(deny process-exec)
(deny process-fork)
${allowGpu ? `
(allow iokit-open)
(allow file-issue-extension)
(allow user-preference-read)` : ""}

(allow file-read* (literal "${cwd}"))

(allow process-exec
    (literal (param "WEBRUN_EXEC_PATH"))
)

(allow file-read*
    (subpath "/usr/lib")
    (subpath "/usr/local/lib")
    (subpath "/System/Library")
    (subpath "/opt/homebrew")
    (literal "/dev/random")
    (literal "/dev/urandom")
    (literal "/dev/null")
    (literal "/dev/tty")
    (literal "/etc/resolv.conf") 
    (literal "/etc/hosts")       
    (literal "/private/etc/resolv.conf") 
    (literal "/private/etc/hosts")       
    (literal "/private/etc/services")       
    (literal "/private/var/run/mDNSResponder")
)

(allow file-read* file-map-executable
    (subpath (param "WEBRUN_EXEC_DIR"))
)

(allow system-socket)
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow network-outbound
    (remote tcp "*:443")
    (remote tcp "*:80")  
    (remote udp "*:53")  
    (literal "/private/var/run/mDNSResponder")${extraNetworkOutbound}
)
${inboundBlock}
(allow file-read* file-write*
    (subpath (param "WEBRUN_SANDBOX_CACHE"))
    (subpath (param "WEBRUN_ISOLATED_TMP"))${allowGpu ? `\n    (regex #"^/private/var/folders/.*$")` : ""}${writeEnclaves}
)

(allow file-read*
    (literal (param "WEBRUN_DENO_JSON"))
    (literal (param "WEBRUN_DENO_JSONC"))
    (literal (param "WEBRUN_DENO_LOCK"))
    (literal (param "WEBRUN_SCRIPT_PATH"))${readEnclaves}
)

(deny file-read* file-write*
    (regex #"^.*/\\.env.*$")
)
`;
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

let isSet = false;
let __rootUrl = "";
let __parentPayload = null;
let __webrunEntryUrl = "";

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
    __rootUrl = ctx.__internalRootUrl || "";
    __parentPayload = ctx.__parentPayload;
    __webrunEntryUrl = ctx.__webrunEntryUrl;
}

export async function webrun(spawnArgs, options = {}) {
    if (spawnArgs.includes("--test")) {
        throw new Error("not yet implemented");
    }
    return new Promise((resolve) => {
        const workerCode = \`
            import { executeInsideSandbox, parseRawArguments } from "\${__webrunEntryUrl}";
            
            self.onmessage = async (e) => {
                if (e.data.type === "spawn") {
                    const preservedDeno = globalThis.Deno;
                    preservedDeno.exit = (code) => {
                        self.postMessage({ type: "exit", code });
                        self.close();
                    };
                    
                    console.log = (...a) => { self.postMessage({ type: "stdout", chunk: a.map(String).join(" ") }); };
                    console.error = (...a) => { self.postMessage({ type: "stderr", chunk: a.map(String).join(" ") }); };
                    
                    try {
                        const childPayload = e.data.payload;
                        const parsed = parseRawArguments(childPayload.sandboxArgs);
                        childPayload.injectedArgsObj = parsed.injectedArgsObj;
                        
                        // Construct targetUrlHref natively from parsed inputs
                        childPayload.action = parsed.isEval ? "eval" : (parsed.isTest ? "test" : (parsed.isCheckOnly ? "check-only" : "run"));
                        if (parsed.isEval) {
                            childPayload.targetScriptPath = "[eval]";
                            childPayload.targetUrlHref = "data:application/typescript;charset=utf-8," + encodeURIComponent(parsed.evalCode);
                            childPayload.evalCode = parsed.evalCode;
                        } else {
                            childPayload.targetScriptPath = parsed.targetScriptPath;
                            childPayload.evalCode = undefined;
                            
                            const rootUrl = childPayload.__internalRootUrl;
                            const resolveUrl = (p) => p.startsWith("http") ? new URL(p).href : new URL(p, rootUrl).href;
                            childPayload.targetUrlHref = Array.isArray(parsed.targetScriptPath)
                                ? parsed.targetScriptPath.map(resolveUrl)
                                : resolveUrl(parsed.targetScriptPath);
                        }
                        
                        await executeInsideSandbox(childPayload);
                    } catch (err) {
                        console.error(err.message || String(err));
                        preservedDeno.exit(1);
                    }
                }
            };
        \`;
        
        const blobUrl = URL.createObjectURL(new Blob([workerCode], { type: "application/javascript" }));
        
        const workerOptions = { 
            type: "module", 
            name: "webrun-sub-worker"
        };
        // Inherit parent constraints securely so the worker can load the webrun polyfill itself
        workerOptions.deno = { permissions: "inherit" };
        
        const worker = new Worker(blobUrl, workerOptions);
        
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
        childPayload.__internalRootUrl = __rootUrl;
        
        // Do not mutate spawnArgs directly here, parseRawArguments needs the original structure
        childPayload.sandboxArgs = [...spawnArgs];
        if (options.memoryMB) childPayload.memoryMB = options.memoryMB;
        if (options.env) childPayload.finalEnvVars = options.env;
        
        worker.postMessage({ type: "spawn", payload: childPayload });
    });
}
`;
    const contextURI = `data:application/typescript;charset=utf-8,${encodeURIComponent(contextCode)}`;

    return {
        imports: {
            "webrun/ctx": contextURI,
            "node:fs": sinkholeURI,
            "node:child_process": sinkholeURI,
            "node:net": sinkholeURI,
            "node:os": sinkholeURI,
            "node:path": sinkholeURI,
            "node:vm": sinkholeURI,
        },
        scopes: {}
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

