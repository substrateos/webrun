import { resolve, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { pathToFileURL } from "node:url";
import { sys, printWarning, printExecutionError, printFatalError, printSecurityFatal, tryRealpathSync, tryStatSync, tryRemoveSync } from "./sys.ts";
import { WebrunConfig, SandboxContextPayload } from "./types.ts";
import { parseCommandInvocation, parseRawArguments, computeRuntimeEnvironment, evaluateEnclavePolicy, generateDenoStorageFlags, generateSeatbeltEnclaveStrings, generateSeatbeltProfile, generateBaseImportMap, rewriteImportMapPathsToAbsolute, mergeImportMaps } from "./config.ts";
export { parseRawArguments };
import { createStorageManager } from "./fs.ts";
// =========================================================
// 4. IMPURE: EXECUTION LIFECYCLES
// =========================================================

export interface FoundConfig {
    config: WebrunConfig;
    dir: string;
    path: string;
}

export function findLocalConfigurations(currentDir: string): FoundConfig[] {
    let configDir = currentDir;
    const allConfigs: FoundConfig[] = [];

    while (true) {
        const potentialWebrunPath = resolve(configDir, "webrun.json");
        const potentialPackagePath = resolve(configDir, "package.json");

        let foundConfig: any = null;
        let foundPath = "";

        try {
            if (sys.statSync(potentialWebrunPath).isFile) {
                foundConfig = JSON.parse(sys.readTextFileSync(potentialWebrunPath));
                foundPath = potentialWebrunPath;
            }
        } catch (_) { }

        if (!foundConfig) {
            try {
                if (sys.statSync(potentialPackagePath).isFile) {
                    const pkgInfo = JSON.parse(sys.readTextFileSync(potentialPackagePath));
                    if (pkgInfo.webrun && typeof pkgInfo.webrun === "object") {
                        foundConfig = pkgInfo.webrun;
                        foundPath = potentialPackagePath;
                    }
                }
            } catch (_) { }
        }

        if (foundConfig) {
            const hasExplicitBindingsWhitelist = foundConfig.permissions && foundConfig.permissions.bindings !== undefined;
            
            if (!foundConfig.permissions) foundConfig.permissions = { storage: {}, network: [], env: [], bindings: [] };
            if (!foundConfig.permissions.storage) foundConfig.permissions.storage = {};
            if (!foundConfig.permissions.network) foundConfig.permissions.network = [];
            if (!foundConfig.permissions.env) foundConfig.permissions.env = [];
            if (!foundConfig.permissions.bindings) foundConfig.permissions.bindings = [];

            if (foundConfig.bindings && !hasExplicitBindingsWhitelist) {
                for (const key of Object.keys(foundConfig.bindings)) {
                    if (!foundConfig.permissions.bindings.includes(key)) {
                        foundConfig.permissions.bindings.push(key);
                    }
                }
            }

            allConfigs.push({ config: foundConfig, dir: configDir, path: foundPath });
        }

        const parent = resolve(configDir, "..");
        if (parent === configDir) break;
        configDir = parent;
    }

    return allConfigs;
}

export function validatePrivilegeNarrowing(parentConfig: WebrunConfig, parentDir: string, childConfig: WebrunConfig, childDir: string) {
    if (parentConfig.limits) {
        if (parentConfig.limits.timeoutMillis !== undefined && childConfig.limits?.timeoutMillis !== undefined && childConfig.limits.timeoutMillis > parentConfig.limits.timeoutMillis) {
            printSecurityFatal("Privilege escalation detected in nested configuration.", {
                Reason: "Escalating 'timeoutMillis' limit",
                Attempted: String(childConfig.limits.timeoutMillis),
                Permitted: String(parentConfig.limits.timeoutMillis),
                Child: childDir,
                Parent: parentDir
            });
            sys.exit(1);
        }
        if (parentConfig.limits.memoryMB !== undefined && childConfig.limits?.memoryMB !== undefined && childConfig.limits.memoryMB > parentConfig.limits.memoryMB) {
            printSecurityFatal("Privilege escalation detected in nested configuration.", {
                Reason: "Escalating 'memoryMB' limit",
                Attempted: String(childConfig.limits.memoryMB),
                Permitted: String(parentConfig.limits.memoryMB),
                Child: childDir,
                Parent: parentDir
            });
            sys.exit(1);
        }
    }

    for (const e of childConfig.permissions!.env!) {
        if (!parentConfig.permissions!.env!.includes(e)) {
            printSecurityFatal("Privilege escalation detected in nested configuration.", {
                Reason: "Escalating 'env' permissions",
                Attempted: e,
                Child: childDir,
                Parent: parentDir
            });
            sys.exit(1);
        }
    }

    for (const n of childConfig.permissions!.network!) {
        if (!parentConfig.permissions!.network!.includes(n)) {
            printSecurityFatal("Privilege escalation detected in nested configuration.", {
                Reason: "Escalating 'network' permissions",
                Attempted: n,
                Child: childDir,
                Parent: parentDir
            });
            sys.exit(1);
        }
    }

    if (childConfig.permissions?.bindings) {
        for (const bindingName of childConfig.permissions.bindings) {
            if (!parentConfig.permissions?.bindings?.includes(bindingName)) {
                printSecurityFatal("Privilege escalation detected in nested configuration.", {
                    Reason: "Escalating 'bindings' permissions",
                    Attempted: bindingName,
                    Child: childDir,
                    Parent: parentDir
                });
                sys.exit(1);
            }
        }
    }

    const parentStorageAbs = Object.entries(parentConfig.permissions!.storage!).map(([k, v]: [string, any]) => ({ path: resolve(parentDir, k), access: v.access }));
    const childStorageAbs = Object.entries(childConfig.permissions!.storage!).map(([k, v]: [string, any]) => ({ path: resolve(childDir, k), access: v.access }));

    for (const c of childStorageAbs) {
        let covered = false;
        for (const p of parentStorageAbs) {
            if (c.path === p.path || c.path.startsWith(p.path + "/")) {
                if (c.access === "write" && p.access !== "write") {
                    continue;
                }
                covered = true;
                break;
            }
        }
        if (!covered) {
            printSecurityFatal("Privilege escalation detected in nested configuration.", {
                Reason: "Escalating 'storage' permissions",
                Attempted: c.path,
                Child: childDir,
                Parent: parentDir
            });
            sys.exit(1);
        }
    }
}

export function mergeConfigurations(allConfigs: FoundConfig[], defaultDir: string): { config: WebrunConfig, configDir: string, configFound: boolean, configPaths: string[], importMapPaths: string[] } {
    const importMapPaths: string[] = [];
    const finalConfig: WebrunConfig = { limits: { timeoutMillis: 120000, memoryMB: 512 }, permissions: { storage: {}, network: [], env: [], bindings: [] } };
    let finalConfigDir = defaultDir;
    let configFound = false;

    if (allConfigs.length > 0) {
        configFound = true;
        const mostSpecific = allConfigs[0];
        finalConfigDir = mostSpecific.dir;

        for (let i = 0; i < allConfigs.length - 1; i++) {
            validatePrivilegeNarrowing(allConfigs[i + 1].config, allConfigs[i + 1].dir, allConfigs[i].config, allConfigs[i].dir);
        }

        Object.assign(finalConfig.permissions!, mostSpecific.config.permissions);

        for (let i = allConfigs.length - 1; i >= 0; i--) {
            const cfg = allConfigs[i].config;
            const dir = allConfigs[i].dir;
            if (cfg.bindings) {
                if (!finalConfig.bindings) finalConfig.bindings = {};
                const parsedBindings = JSON.parse(JSON.stringify(cfg.bindings));
                for (const v of Object.values(parsedBindings) as any[]) {
                    if (v.module && typeof v.module === "string") {
                        v.module = resolve(dir, v.module);
                    }
                }
                Object.assign(finalConfig.bindings, parsedBindings);
            }
        }

        if (finalConfig.bindings && finalConfig.permissions?.bindings) {
            const allowed = finalConfig.permissions.bindings;
            for (const key of Object.keys(finalConfig.bindings)) {
                if (!allowed.includes(key)) {
                    delete finalConfig.bindings[key];
                }
            }
        }


        for (let i = allConfigs.length - 1; i >= 0; i--) {
            const cfg = allConfigs[i].config;
            if (cfg.importMap) {
                importMapPaths.push(resolve(allConfigs[i].dir, cfg.importMap));
            }
        }

        for (let i = allConfigs.length - 1; i >= 0; i--) {
            const cfg = allConfigs[i].config;
            if (cfg.limits) {
                if (cfg.limits.timeoutMillis !== undefined) finalConfig.limits!.timeoutMillis = Math.min(finalConfig.limits!.timeoutMillis!, cfg.limits.timeoutMillis);
                if (cfg.limits.memoryMB !== undefined) finalConfig.limits!.memoryMB = Math.min(finalConfig.limits!.memoryMB!, cfg.limits.memoryMB);
            }
        }
    }

    return { config: finalConfig, configDir: finalConfigDir, configFound, configPaths: allConfigs.map(c => c.path), importMapPaths };
}

export function resolveLocalConfiguration(currentDir: string): { config: WebrunConfig, configDir: string, configFound: boolean, configPaths: string[], importMapPaths: string[] } {
    const allConfigs = findLocalConfigurations(currentDir);
    return mergeConfigurations(allConfigs, currentDir);
}

export function buildNodeSinkholeDependencies(isolatedTmp: string, importMapPaths: string[] = []): string {
    const importMapPayload = generateBaseImportMap();

    for (const absMapPath of importMapPaths) {
        try {
            const userMap = JSON.parse(sys.readTextFileSync(absMapPath));
            rewriteImportMapPathsToAbsolute(userMap, dirname(absMapPath));
            mergeImportMaps(importMapPayload, userMap);
        } catch (e: any) {
            printWarning(`Failed to parse or merge importMap at ${absMapPath}: ${e.message}`);
        }
    }

    const combinedPath = resolve(isolatedTmp, "sandbox_import_map.json");
    sys.writeTextFileSync(combinedPath, JSON.stringify(importMapPayload));
    return combinedPath;
}


class WebrunSkipError extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "WebrunSkipError";
    }
}

function createGuestTestContext(denoCtx: any): any {
    return {
        name: denoCtx.name,
        async run(subName: string, subFn: Function) {
            await denoCtx.step(subName, async (subT: any) => {
                await subFn(createGuestTestContext(subT));
            });
        },
        log(...args: any[]) { console.log(...args); },
        assert(cond: any, msg: string) { if (!cond) throw new Error(msg || "Assertion failed"); },
        fail(msg: string) { throw new Error(msg || "Test failed explicitly"); },
        skip(msg: string = "Skipped") {
            console.log(`\x1b[33m[SKIP]\x1b[0m ${msg}`);
            throw new WebrunSkipError(msg);
        }
    };
}

export async function executeTestPayload(payload: SandboxContextPayload, contextPayload: any, preservedDeno: any) {
    const targetUrls = Array.isArray(payload.targetUrlHref) ? payload.targetUrlHref : [payload.targetUrlHref as string];
    const targetPaths = Array.isArray(payload.targetScriptPath) ? payload.targetScriptPath : [payload.targetScriptPath as string];

    const allTestExports: { name: string, fn: Function, scriptPath: string }[] = [];

    for (let i = 0; i < targetUrls.length; i++) {
        const url = targetUrls[i];
        const mod = await import(url);
        const scriptPath = targetPaths[i];
        const testExports = Object.entries(mod).filter(([k, v]) => k.startsWith("test") && typeof v === "function");
        for (const [name, fn] of testExports) {
            allTestExports.push({ name, fn: fn as Function, scriptPath });
        }
    }

    if (allTestExports.length === 0) {
        console.warn("[Webrun] No test exports found. Expected functions starting with 'test'.");
        preservedDeno.exit(0);
        return;
    }

    const webrunCtxMod = await import("webrun/ctx").catch(() => null);
    if (webrunCtxMod && webrunCtxMod.set) {
        webrunCtxMod.set(contextPayload);
    }

    const filterStr = contextPayload.flags?.filter;

    for (const { name, fn, scriptPath } of allTestExports) {
        const cleanName = typeof name === 'string' ? (name.startsWith("test") ? name.substring(4).trim() : name) : String(name);
        if (filterStr && !cleanName.includes(filterStr) && !name.includes(filterStr)) {
            continue;
        }

        preservedDeno.test({
            name: cleanName,
            sanitizeOps: false,
            sanitizeResources: false,
            sanitizeExit: false,
            async fn(stepCtx: any) {
                const guestT = createGuestTestContext(stepCtx);
                if (payload.isSelfTest) {
                    (guestT as any).Deno = preservedDeno;
                    (guestT as any).WORKER_BIN = payload.webrunBin;
                    (guestT as any).IS_REPACKED_TEST = payload.isRepackedTest;
                }
                try {
                    contextPayload.command = scriptPath;
                    await fn(guestT, contextPayload);
                } catch (err: any) {
                    if (err instanceof WebrunSkipError || err?.name === "WebrunSkipError") {
                        return;
                    }
                    throw err;
                }
            }
        });
    }
}

export async function executeRunPayload(payload: SandboxContextPayload, contextPayload: any, preservedDeno: any) {
    contextPayload.command = payload.targetScriptPath as string;

    const webrunCtxMod = await import("webrun/ctx").catch(() => null);
    if (webrunCtxMod && webrunCtxMod.set) {
        webrunCtxMod.set(contextPayload);
    }

    const mod = await import(payload.targetUrlHref as string);
    const mainFn = typeof mod.default === 'function' ? mod.default : (mod.default && typeof mod.default.main === 'function' ? mod.default.main : null);
    if (mainFn) {
        await mainFn(contextPayload);
    }
    preservedDeno.exit(0);
}

const rewriteDenoError = (msg: string): string => {
    if (!msg) return msg;
    if (msg.includes("run again with the --allow-")) {
        return msg.replace(/, run again with the --allow-[a-z-]+ flag/g, "")
            + ".\n  Hint: Update the 'permissions' object in your webrun.json to allow this operation.";
    }
    return msg;
};

export function setupSandboxErrorHandlers(preservedDeno: any) {
    globalThis.addEventListener('unhandledrejection', (e: any) => {
        if (e.reason && e.reason.name === "WebrunSkipError") return;
        e.preventDefault();
        printExecutionError(rewriteDenoError(e.reason?.message || String(e.reason)));
        preservedDeno.exit(1);
    });

    globalThis.addEventListener('error', (e: any) => {
        e.preventDefault();
        printExecutionError(rewriteDenoError(e.error?.message || String(e.error)));
        preservedDeno.exit(1);
    });
}

export function setupMemoryMonitor(memoryMB: number, preservedDeno: any) {
    const MAX_RSS_BYTES = memoryMB * 1024 * 1024;
    const getMemoryUsage = preservedDeno.memoryUsage.bind(preservedDeno);
    setInterval(() => {
        const usage = getMemoryUsage();
        if (usage.rss > MAX_RSS_BYTES) {
            const currentMB = (usage.rss / 1024 / 1024).toFixed(2);
            printFatalError("Memory limit exceeded!", `Current: ${currentMB}MB / Allowed: ${memoryMB}MB`);
            preservedDeno.exit(137);
        }
    }, 500);
}

function setupSandboxGlobals(payload: SandboxContextPayload, preservedDeno: any) {
    const opfsManager = createStorageManager(payload.opfsRoot, true);

    if (!(globalThis as any).navigator) {
        (globalThis as any).navigator = {};
    }
    (globalThis as any).navigator.storage = opfsManager;

    setupSandboxErrorHandlers(preservedDeno);

    if (payload.memoryMB) {
        setupMemoryMonitor(payload.memoryMB, preservedDeno);
    }
}

function setupFetchProxy(payload: SandboxContextPayload) {
    const originalFetch = globalThis.fetch;
    const moduleWorkers: Record<string, any> = {};
    const proxyMap: Record<string, string> = {};

    for (const [name, b] of Object.entries(payload.bindingsMap || {})) {
        if (b.type === 'process') {
            proxyMap[b.uuid] = `http://127.0.0.1:${b.port}`;
        } else if (b.type === 'module') {
            const workerUrl = new URL(b.path as string, `file://${payload.storageRoot}/`).href;
            const w = new (globalThis as any).Worker(
                `data:application/javascript,import mod from "${workerUrl}"; self.onmessage = async (e) => { const { id, req } = e.data; try { const r = await (mod.default ? mod.default.fetch : mod.fetch)(new Request(req.url, req)); const buf = await r.arrayBuffer(); const headers = {}; for (const [k,v] of r.headers) headers[k]=v; self.postMessage({ id, status: r.status, headers, body: buf }, [buf]); } catch (err) { self.postMessage({ id, error: err.message }); } };`,
                { type: "module", deno: { permissions: "inherit" } }
            );
            moduleWorkers[b.uuid] = w;
            proxyMap[b.uuid] = 'worker';
        }
    }

    let fetchMsgId = 0;
    const workerResolvers: Record<number, any> = {};
    for (const w of Object.values(moduleWorkers)) {
        w.onmessage = (e: any) => {
            const res = workerResolvers[e.data.id];
            if (res) {
                if (e.data.error) {
                    printExecutionError(e.data.error);
                    res.resolve(new Response(e.data.error, { status: 500 }));
                } else {
                    res.resolve(new Response(e.data.body, { status: e.data.status, headers: e.data.headers }));
                }
                delete workerResolvers[e.data.id];
            }
        };
    }

    globalThis.fetch = async function(resource: any, init?: any) {
        if (!resource) throw new TypeError("Failed to fetch: Request cannot be constructed from undefined");
        const urlReq = typeof resource === 'string' ? resource : resource.url;
        const urlObj = new URL(urlReq);
        if (urlObj.protocol === 'webrun:') {
            const uuid = urlObj.hostname;
            const route = proxyMap[uuid];
            if (!route) throw new TypeError(`Failed to fetch: No binding mapped to ${urlObj.href}`);
            
            if (route === 'worker') {
                const w = moduleWorkers[uuid];
                const id = ++fetchMsgId;
                
                const bodyPromise = (async () => {
                    const finalReq = new Request(resource, init);
                    return {
                        url: finalReq.url,
                        method: finalReq.method,
                        headers: Object.fromEntries(finalReq.headers.entries()),
                        body: finalReq.body ? await finalReq.clone().arrayBuffer() : undefined
                    };
                })();

                return new Promise((resolve, reject) => {
                    workerResolvers[id] = { resolve, reject };
                    bodyPromise.then(reqObj => {
                        w.postMessage({ id, req: reqObj }, reqObj.body ? [reqObj.body] : undefined);
                    }).catch(reject);
                });
            } else {
                const proxyUrl = new URL(urlObj.pathname + urlObj.search, route);
                return originalFetch(proxyUrl.href, init || (resource instanceof Request ? resource : undefined));
            }
        }
        
        const hn = urlObj.hostname;
        if (hn.startsWith("127.") || hn === "localhost" || hn === "0.0.0.0") {
            if (hn === "127.0.0.1" && Object.values(proxyMap).includes(`http://127.0.0.1:${urlObj.port}`)) {
                // Allowed
            } else {
                throw new TypeError(`Failed to fetch: SSRF Blocked by Sandbox (${hn})`);
            }
        }

        return originalFetch(resource, init);
    };
}

export async function executeInsideSandbox(payload: SandboxContextPayload) {
    const rawArgs = payload.injectedArgsObj;
    const argsPayload: string[] = [...rawArgs["--"]];
    const flags = { ...rawArgs };
    delete flags["--"];

    const storageManager = createStorageManager(payload.storageRoot, payload.fallbackToTemp);
    const preservedDeno = (globalThis as any).Deno;
    
    setupSandboxGlobals(payload, preservedDeno);
    setupFetchProxy(payload);

    delete (globalThis as any).Deno;

    try {
        const contextPayload = {
            args: argsPayload,
            flags: flags,
            env: payload.finalEnvVars,
            command: Array.isArray(payload.targetScriptPath) ? payload.targetScriptPath[0] : payload.targetScriptPath,
            argv: [payload.webrunBin, ...(payload.sandboxArgs || [])],
            dir: await storageManager.getDirectory(),
            persisted: !payload.fallbackToTemp,
            bindings: Object.fromEntries(Object.entries(payload.bindingsMap || {}).map(([k, v]: any) => [k, 'webrun://' + v.uuid])),
            __internalRootUrl: `file://${payload.storageRoot}/`, // For resolving dynamic imports
            __parentPayload: payload,
            __webrunEntryUrl: new URL(import.meta.url).href
        };

        if (payload.action === "test") {
            await executeTestPayload(payload, contextPayload, preservedDeno);
        } else {
            await executeRunPayload(payload, contextPayload, preservedDeno);
        }
    } catch (err: any) {
        printExecutionError(rewriteDenoError(err?.message || String(err)));
        await new Promise(r => setTimeout(r, 10));
        preservedDeno.exit(1);
    }
}

function buildDenoArgs(
    invocation: any,
    lockFlag: string[],
    MAX_V8_MEM_MB: number,
    importMapPath: string,
    ephemeralPorts: number[],
    policy: any,
    isolatedTmp: string,
    runnerTmp: string,
    opfsTmp: string,
    bindingSdksTmp: string,
    bootstrapPath: string
): string[] {
    const isCheckOnly = invocation.action === "check-only";

    const innerDenoArgs = [
        invocation.action === "eval" ? "run" : (isCheckOnly ? "check" : invocation.action),
        ...(invocation.isSelfTest || isCheckOnly ? [] : invocation.networkFlags),
        ...lockFlag
    ];

    if (!isCheckOnly) {
        innerDenoArgs.push("--unstable-worker-options");
    }

    innerDenoArgs.push(
        `--v8-flags=--max-old-space-size=${MAX_V8_MEM_MB}`,
        `--import-map=${importMapPath}`
    );

    if (!isCheckOnly) {
        innerDenoArgs.push("--no-prompt", "--no-npm", "--no-check");
    }

    const denyIdx = innerDenoArgs.findIndex(a => a.startsWith("--deny-net="));
    if (denyIdx !== -1) {
        innerDenoArgs.splice(denyIdx, 1, innerDenoArgs[denyIdx].replace("127.0.0.0/8,", "").replace(",localhost", "").replace(",0.0.0.0/8", ""));
    }
    const globalDenyIdx = innerDenoArgs.indexOf("--deny-net");
    if (ephemeralPorts && ephemeralPorts.length > 0 && !isCheckOnly) {
        if (globalDenyIdx !== -1) {
            innerDenoArgs.splice(globalDenyIdx, 1);
            innerDenoArgs.push("--deny-net=10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,169.254.0.0/16");
        }
        for (const port of ephemeralPorts) {
            innerDenoArgs.push(`--allow-net=127.0.0.1:${port}`);
        }
    }

    if (invocation.isSelfTest) {
        if (!isCheckOnly) innerDenoArgs.push("-A");
    } else if (!isCheckOnly) {
        const storageFlags = generateDenoStorageFlags(policy, isolatedTmp, runnerTmp, opfsTmp, bindingSdksTmp, new URL(import.meta.url).pathname);
        innerDenoArgs.push(...storageFlags, `--allow-env=TMP_DIR`);
    }

    if (isCheckOnly) {
        if (Array.isArray(invocation.targetScriptPath)) {
            innerDenoArgs.push(...invocation.targetScriptPath);
        } else {
            innerDenoArgs.push(invocation.targetScriptPath as string);
        }
    } else {
        innerDenoArgs.push(bootstrapPath);
    }

    return innerDenoArgs;
}

function buildMacSandboxArgs(
    isMac: boolean,
    seatbeltProfile: string,
    localDenoDir: string,
    isolatedTmp: string,
    projectRoot: string,
    lockFlag: string[],
    innerDenoArgs: string[]
): { baseCmd: string, execArgs: string[] } {
    const baseCmd = isMac ? "sandbox-exec" : sys.execPath();

    const execArgs = isMac ? [
        "-p", seatbeltProfile,
        "-D", `WEBRUN_SANDBOX_CACHE=${localDenoDir}`,
        "-D", `WEBRUN_ISOLATED_TMP=${isolatedTmp}`,
        "-D", `WEBRUN_DENO_JSON=${resolve(projectRoot, "deno.json")}`,
        "-D", `WEBRUN_DENO_JSONC=${resolve(projectRoot, "deno.jsonc")}`,
        "-D", `WEBRUN_DENO_LOCK=${lockFlag.length ? lockFlag[0].split('=')[1] : resolve(projectRoot, "deno.lock")}`,
        "-D", `WEBRUN_SCRIPT_PATH=${sys.realPathSync(new URL(import.meta.url).pathname)}`,
        "-D", `WEBRUN_DENO_BIN_DIR=${dirname(sys.execPath())}`,
        "-D", `WEBRUN_DENO_BIN_PATH=${sys.execPath()}`,
        sys.execPath(),
        ...innerDenoArgs
    ] : innerDenoArgs;

    return { baseCmd, execArgs };
}

export async function buildSandboxExecutionConfig(
    invocation: any,
    config: WebrunConfig,
    policy: any,
    projectRoot: string,
    isolatedTmp: string,
    runnerTmp: string,
    opfsTmp: string,
    localDenoDir: string,
    importMapPath: string,
    seatbeltProfile: string,
    lockFlag: string[],
    MAX_V8_MEM_MB: number,
    bindingsMap: Record<string, { type: "process" | "module"; uuid: string; path?: string; port?: number }>,
    ephemeralPorts: number[],
    bindingSdksTmp: string,
): Promise<{ baseCmd: string; cmdOptions: any }> {
    const resolveTargetUrl = (p: string) => p.startsWith("http") ? new URL(p).href : pathToFileURL(p).href;
    let targetUrlHref: string | string[];
    if (invocation.action === "eval") {
        targetUrlHref = `data:application/typescript;charset=utf-8,${encodeURIComponent(invocation.evalCode!)}`;
    } else {
        targetUrlHref = Array.isArray(invocation.targetScriptPath)
            ? invocation.targetScriptPath.map(resolveTargetUrl)
            : resolveTargetUrl(invocation.targetScriptPath as string);
    }

    const payloadObject: SandboxContextPayload = {
        action: invocation.action,
        isSelfTest: invocation.isSelfTest,
        webrunBin: sys.env.get("WEBRUN_BIN") || resolve(projectRoot, "webrun"),
        isRepackedTest: sys.env.get("WEBRUN_IS_REPACKED_TEST") === "1",
        storageRoot: policy.storageRoot,
        fallbackToTemp: policy.fallbackToTemp,
        injectedArgsObj: invocation.injectedArgsObj,
        finalEnvVars: computeRuntimeEnvironment(config.permissions?.env),
        targetUrlHref,
        targetScriptPath: invocation.targetScriptPath,
        evalCode: invocation.evalCode,
        sandboxArgs: invocation.sandboxArgs,
        opfsRoot: opfsTmp,
        memoryMB: config.limits?.memoryMB,
        bindingsMap: bindingsMap || {},
        allowedBindings: policy.allowedBindings,
    };
    const bootstrapPath = resolve(runnerTmp, "webrun_bootstrap.ts");
    const bootstrapCode = `import { executeInsideSandbox } from "${new URL(import.meta.url).href}";\nconst payload = ${JSON.stringify(payloadObject)};\nawait executeInsideSandbox(payload);\n`;
    sys.writeTextFileSync(bootstrapPath, bootstrapCode);

    const innerDenoArgs = buildDenoArgs(
        invocation, lockFlag, MAX_V8_MEM_MB, importMapPath, ephemeralPorts,
        policy, isolatedTmp, runnerTmp, opfsTmp, bindingSdksTmp, bootstrapPath
    );

    const isMac = sys.build.os === "darwin" && !invocation.isSelfTest;
    const { baseCmd, execArgs } = buildMacSandboxArgs(
        isMac, seatbeltProfile, localDenoDir, isolatedTmp, projectRoot, lockFlag, innerDenoArgs
    );

    const envVars = { ...payloadObject.finalEnvVars };
    if (invocation.isSelfTest) {
        if (payloadObject.webrunBin) envVars["WEBRUN_BIN"] = payloadObject.webrunBin;
        envVars["WEBRUN_IS_REPACKED_TEST"] = payloadObject.isRepackedTest ? "1" : "0";
        envVars["WEBRUN_DENO_DIR"] = dirname(sys.execPath());
    }

    const cmdOptions: any = {
        args: execArgs,
        env: {
            ...envVars,
            "HOME": isolatedTmp,
            "TMPDIR": isolatedTmp,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
            "USER": "sandbox",
            "DENO_DIR": localDenoDir,
            "TMP_DIR": isolatedTmp
        },
        clearEnv: true,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit"
    };

    if (config.limits?.timeoutMillis) {
        cmdOptions.signal = AbortSignal.timeout(config.limits.timeoutMillis);
    }

    return { baseCmd, cmdOptions };
}

async function handleCliCommands(args: string[], projectRoot: string) {
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

    if (webrunFlags.includes("--self-check") || webrunFlags.includes("--self-test")) {
        const checkCmd = new sys.Command(sys.execPath(), {
            args: ["check", new URL(import.meta.url).pathname],
            stdout: "inherit",
            stderr: "inherit"
        });
        const status = await checkCmd.output();
        if (status.code !== 0 || !webrunFlags.includes("--self-test")) {
            sys.exit(status.code);
        }
    }

    if (webrunFlags.includes("--help") || webrunFlags.includes("-h")) {
        try {
            const selfPath = sys.env.get("WEBRUN_BIN") || resolve(projectRoot, "webrun");
            let readmeContent = sys.readTextFileSync(selfPath);
            if (readmeContent.match(/^__README_DATA__\s*$/m)) {
                readmeContent = readmeContent.split(/^__README_DATA__\s*$/m)[1].split(/^__LICENSE_DATA__\s*$/m)[0];
            } else {
                readmeContent = sys.readTextFileSync(resolve(dirname(selfPath), "README.md"));
            }
            console.log(`Usage: webrun [options] <script.ts> [args...]\n\nOptions:\n  -h, --help         Print the usage instructions\n  -e, --eval <code>  Evaluate the given code instead of reading from a file\n  --self-test        Run the built-in test suite to verify the sandbox is working correctly\n  --self-bundle      Package the webrun source files into a single executable file\n  --self-unbundle <dest>  Extract the webrun source files from the executable into a folder for editing\n  --test             Run the target script as a test suite instead of a standard program\n`);
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

function validateSandboxSafetyBoundaries(policy: any, cwd: string, protectedFiles: string[], allowedWriteEnclaves: string[]) {
    for (const allowed of allowedWriteEnclaves) {
        const canonicalAllowed = tryRealpathSync(allowed) || allowed;

        for (const rawProtectedFile of protectedFiles) {
            const protectedFile = tryRealpathSync(rawProtectedFile) || rawProtectedFile;

            if (protectedFile === canonicalAllowed || protectedFile.startsWith(canonicalAllowed + "/")) {
                printSecurityFatal("The webrun file is within a permitted write directory. Refusing to run.", {
                    Executable: protectedFile,
                    Permitted: canonicalAllowed
                });
                sys.exit(1);
            }
        }
    }

    if (!policy.isPwdAllowed && !policy.fallbackToTemp) {
        printSecurityFatal("The working directory is not granted read access in webrun.json storage permissions.", {
            Directory: cwd
        });
        sys.exit(1);
    }
}

function setupBindingProcesses(config: WebrunConfig, cwd: string, configDir: string, policy: any, bindingSdksTmp: string, importMapPath: string) {
    const bindingsMap: Record<string, any> = {};
    const ephemeralPorts: number[] = [];
    const activeProcesses: any[] = [];

    if (config.bindings) {
        for (const [name, bindingConfig] of Object.entries(config.bindings)) {
            const uuid = crypto.randomUUID();
            let processConfig = bindingConfig.process;
            let moduleConfig = bindingConfig.module;

            if (processConfig) {
                const l = (globalThis as any).Deno.listen({ port: 0, hostname: "127.0.0.1" });
                const port = (l.addr as any).port;
                l.close();
                ephemeralPorts.push(port);

                const env = { ...(sys.env as any).toObject() };
                if (processConfig.portEnv) env[processConfig.portEnv] = String(port);

                let allowedEnv: Record<string, string> = { "PATH": (sys.env.get("PATH") || "") + ":" + (sys.env.get("WEBRUN_DENO_BIN_DIR") || "") };
                if (processConfig.permissions?.env) {
                    for (const k of processConfig.permissions.env) allowedEnv[k] = sys.env.get(k) || "";
                } else allowedEnv = env;
                
                if (processConfig.portEnv) allowedEnv[processConfig.portEnv] = String(port);
                const cmdExe = processConfig.command[0] === "deno" ? sys.execPath() : processConfig.command[0];
                const cmd = new sys.Command(cmdExe, {
                    args: processConfig.command.slice(1),
                    cwd: cwd,
                    env: allowedEnv,
                    clearEnv: true,
                    stdin: "null",
                    stdout: "inherit",
                    stderr: "inherit"
                });
                
                try {
                    activeProcesses.push(cmd.spawn());
                } catch (e: any) {
                    printExecutionError(`Failed to spawn binding process ${name}: ${e.message}`);
                    sys.exit(1);
                }

                bindingsMap[name] = { type: 'process', uuid, port };
            } else if (moduleConfig) {
                const absPath = tryRealpathSync(resolve(configDir, moduleConfig as string)) || resolve(configDir, moduleConfig as string);
                bindingsMap[name] = { type: 'module', uuid, path: absPath };
                policy.allowedReadPaths.push(absPath);
                
                const sdkPath = resolve(bindingSdksTmp, `${uuid}.js`);
                sys.writeTextFileSync(sdkPath, `export default { async fetch(req) { const u = typeof req === 'string' ? new URL(req) : new URL(req.url); const target = "webrun://${uuid}" + u.pathname + u.search; if (typeof req === 'string') return await fetch(target); const init = { method: req.method, headers: req.headers }; if (req.body && req.method !== 'GET' && req.method !== 'HEAD') { init.body = req.body; } return await fetch(target, init); } };`);
                
                const importMapPayload = JSON.parse(sys.readTextFileSync(importMapPath));
                importMapPayload.imports = importMapPayload.imports || {};
                importMapPayload.imports[`webrun://${uuid}`] = `file://${sdkPath}`;
                sys.writeTextFileSync(importMapPath, JSON.stringify(importMapPayload));
            }
        }
    }
    
    globalThis.addEventListener('unload', () => {
        for (const p of activeProcesses) {
            try { p.kill("SIGTERM"); } catch (_) {}
        }
    });

    return { bindingsMap, ephemeralPorts, activeProcesses };
}

export async function spawnSandboxProcess(cwd: string, args: string[]) {
    // 1. Setup Ephemeral Paths & Config
    const projectRoot = sys.realPathSync(cwd);
    const localDenoDir = (() => {
        const d = resolve(sys.env.get("HOME") || "/tmp", ".webrun_cache");
        sys.mkdirSync(d, { recursive: true });
        return sys.realPathSync(d);
    })();
    const isolatedTmp = sys.realPathSync(sys.makeTempDirSync({ prefix: 'sandbox_tmp_' }));
    const runnerTmp = sys.realPathSync(sys.makeTempDirSync({ prefix: 'webrun_runner_' }));
    const opfsTmp = sys.realPathSync(sys.makeTempDirSync({ prefix: 'webrun_opfs_' }));
    const bindingSdksTmp = sys.realPathSync(sys.makeTempDirSync({ prefix: 'webrun_bindings_' }));
    const { config, configDir, configFound, configPaths, importMapPaths } = resolveLocalConfiguration(cwd);

    const MAX_V8_MEM_MB = config.limits?.memoryMB || 512;

    await handleCliCommands(args, projectRoot);

    // 2. Parse Routing State
    const invocation = parseCommandInvocation(args, config);
    const policy = evaluateEnclavePolicy(config.permissions?.storage || {}, config.permissions?.bindings || [], configDir, cwd, isolatedTmp);

    const protectedFiles: string[] = [...configPaths, ...importMapPaths];

    const binPath = tryRealpathSync(sys.env.get("WEBRUN_BIN") || resolve(projectRoot, "webrun"));
    if (binPath) protectedFiles.push(binPath);

    const selfPath = tryRealpathSync(new URL(import.meta.url).pathname);
    if (selfPath) protectedFiles.push(selfPath);

    const allowedWriteEnclaves = [isolatedTmp, ...policy.allowedWritePaths, opfsTmp, bindingSdksTmp];
    policy.allowedReadPaths.push(bindingSdksTmp);

    for (const { dir } of findLocalConfigurations(cwd)) {
        const canonical = tryRealpathSync(dir) || dir;
        protectedFiles.push(canonical);
    }

    validateSandboxSafetyBoundaries(policy, cwd, protectedFiles, allowedWriteEnclaves);

    const importMapPath = buildNodeSinkholeDependencies(isolatedTmp, importMapPaths);

    const { bindingsMap, ephemeralPorts, activeProcesses } = setupBindingProcesses(config, cwd, configDir, policy, bindingSdksTmp, importMapPath);

    // 3. Compile Security Vectors
    const webrunEntryPath = new URL(import.meta.url).pathname;
    const { readEnclaves, writeEnclaves } = generateSeatbeltEnclaveStrings(policy, runnerTmp, opfsTmp, bindingSdksTmp, webrunEntryPath);
    const seatbeltProfile = generateSeatbeltProfile(cwd, readEnclaves, writeEnclaves, ephemeralPorts);

    const lockFlag: string[] = [];
    const lockFilePath = resolve(projectRoot, "deno.lock");
    if (tryStatSync(lockFilePath)?.isFile) lockFlag.push(`--lock=${lockFilePath}`);

    // 4. Assemble Process Image
    const { baseCmd, cmdOptions } = await buildSandboxExecutionConfig(
        invocation,
        config,
        policy,
        projectRoot,
        isolatedTmp,
        runnerTmp,
        opfsTmp,
        localDenoDir,
        importMapPath,
        seatbeltProfile,
        lockFlag,
        MAX_V8_MEM_MB,
        bindingsMap,
        ephemeralPorts,
        bindingSdksTmp
    );

    const cmd = new sys.Command(baseCmd, cmdOptions);

    try {
        const child = cmd.spawn();
        const status = await child.status;
        tryRemoveSync(isolatedTmp, { recursive: true });
        tryRemoveSync(runnerTmp, { recursive: true });
        tryRemoveSync(opfsTmp, { recursive: true });
        sys.exit(status.code);
    } catch (e: any) {
        tryRemoveSync(isolatedTmp, { recursive: true });
        tryRemoveSync(runnerTmp, { recursive: true });
        tryRemoveSync(opfsTmp, { recursive: true });
        if (e.name === "AbortError") {
            printExecutionError(`Timeout limit reached after ${config.limits?.timeoutMillis}ms`);
            sys.exit(143);
        }
        printExecutionError("Failed to spawn", e.message || String(e));
        sys.exit(1);
    }
}

