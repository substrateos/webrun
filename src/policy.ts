import { resolve, dirname, isAbsolute } from "https://deno.land/std@0.224.0/path/mod.ts";
import { tryRealpathSync } from "./sys.ts";

/**
 * Thrown when a security constraint is violated. Replaces the former
 * sys.exit(1) pattern so that control flow halts explicitly even when
 * sys.exit is a mock (e.g. in tests).
 */
export class SecurityViolationError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "SecurityViolationError";
    }
}
import { printWarning, printSecurityFatal } from "./log.ts";
import { WebrunConfig, PolicyRuntime, CapabilityRequest } from "./types.ts";
import { generateBaseImportMap, rewriteImportMapPathsToAbsolute, mergeImportMaps } from "./config.ts";

// =========================================================
// POLICY: Security decisions, config discovery, privilege narrowing
// =========================================================

export interface EnclavePolicy {
    isPwdAllowed: boolean;
    fallbackToTemp: boolean;
    storageRoot: string;
    allowedReadPaths: string[];
    allowedWritePaths: string[];
    allowedBindings: string[];
}

/**
 * Evaluates the localized configuration to construct an active enclave policy mapping boundary.
 * Calculates read/write capabilities derived strictly from the explicit webrun.json storage manifest
 * without implicitly expanding permissions (e.g. implicitly loading module paths is not natively whitelisted).
 */
export function evaluateEnclavePolicy(sys: PolicyRuntime, configDirs: Record<string, import("./types.ts").WebrunStorageAccess>, configBindings: string[], configDir: string, currentDir: string, isolatedTmp: string): EnclavePolicy {
    let isPwdAllowed = false;
    const fallbackToTemp = Object.keys(configDirs).length === 0;

    const allowedReadPaths: string[] = [];
    const allowedWritePaths: string[] = [];
    const allowedBindings: string[] = [];

    for (let [fsPath, settings] of Object.entries(configDirs)) {
        // Structural constraints: reject paths before resolution to make
        // the invariant structural rather than computational.
        if (isAbsolute(fsPath)) {
            printSecurityFatal("Storage permissions cannot use absolute paths. Use relative paths from the config directory.", {
                Attempted: fsPath,
                ConfigDir: configDir
            });
            throw new SecurityViolationError(`Absolute storage path: ${fsPath}`);
        }
        if (fsPath.split("/").includes("..") || fsPath.split("\\").includes("..")) {
            printSecurityFatal("Storage permissions cannot traverse outside the configuration directory.", {
                Attempted: fsPath,
                ConfigDir: configDir
            });
            throw new SecurityViolationError(`Traversal in storage path: ${fsPath}`);
        }

        const absFsPath = resolve(configDir, fsPath);
        if (!absFsPath.startsWith(configDir) && absFsPath !== configDir) {
            printSecurityFatal("Storage permissions cannot traverse outside the configuration directory.", {
                Attempted: fsPath,
                ConfigDir: configDir
            });
            throw new SecurityViolationError(`Storage path escapes config dir: ${fsPath}`);
        }
        
        if (currentDir === absFsPath || currentDir.startsWith(absFsPath + "/")) {
            isPwdAllowed = true;
        }

        if (settings.access === "delegate" || settings.access === "none") {
            continue;
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

// =========================================================
// Configuration discovery, merging, and privilege narrowing
// =========================================================

export interface FoundConfig {
    config: WebrunConfig;
    dir: string;
    path: string;
}

export function findLocalConfigurations(sys: PolicyRuntime, currentDir: string): FoundConfig[] {
    let configDir = currentDir;
    const allConfigs: FoundConfig[] = [];

    while (true) {
        const potentialWebrunPath = resolve(configDir, "webrun.json");
        const potentialPackagePath = resolve(configDir, "package.json");

        let foundConfig: any = null;
        let foundPath = "";

        try {
            const content = sys.readTextFileSync(potentialWebrunPath);
            foundConfig = JSON.parse(content);
            foundPath = potentialWebrunPath;
        } catch (_) { }

        if (!foundConfig) {
            try {
                const pkgInfo = JSON.parse(sys.readTextFileSync(potentialPackagePath));
                if (pkgInfo.webrun && typeof pkgInfo.webrun === "object") {
                    foundConfig = pkgInfo.webrun;
                    foundPath = potentialPackagePath;
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

export function resolveLocalConfiguration(sys: PolicyRuntime, currentDir: string): { config: WebrunConfig, configDir: string, configFound: boolean, configPaths: string[], importMapPaths: string[] } {
    const allConfigs = findLocalConfigurations(sys, currentDir);
    if (allConfigs.length === 0) {
        return { config: { permissions: { storage: {}, network: [], env: [], bindings: [] } }, configDir: currentDir, configFound: false, configPaths: [], importMapPaths: [] };
    }

    // OCap Chain Evaluation
    // 1. Target config (most specific) builds the initial CapabilityRequest
    const targetConfig = allConfigs[0];
    const initialConfigDir = targetConfig.dir;

    const request: CapabilityRequest = {
        network: targetConfig.config.permissions?.network || [],
        storage: Object.entries(targetConfig.config.permissions?.storage || {}).map(([k, v]: [string, any]) => ({ path: resolve(initialConfigDir, k), access: v.access })),
        env: targetConfig.config.permissions?.env || [],
        bindings: targetConfig.config.permissions?.bindings || [],
        import: targetConfig.config.permissions?.import || [],
        gpu: !!targetConfig.config.permissions?.gpu,
        webrtc: !!targetConfig.config.permissions?.webrtc,
    };

    const finalConfig: WebrunConfig = { 
        permissions: { ...targetConfig.config.permissions },
        bindings: {},
        aliases: {},
        locations: {},
        limits: {},
        serve: targetConfig.config.serve,
        experimental: targetConfig.config.experimental,
    };

    const importMapPaths: string[] = [];

    // Evaluate the request up the chain
    for (let i = 0; i < allConfigs.length; i++) {
        const sourceConfig = allConfigs[i].config;
        const sourceDir = allConfigs[i].dir;
        
        // 1. Isolate Check (Airgap Mutex)
        if (sourceConfig.isolate) {
            for (const isolatePathRaw of sourceConfig.isolate) {
                const isolatePath = tryRealpathSync(sys, resolve(sourceDir, isolatePathRaw)) || resolve(sourceDir, isolatePathRaw);
                for (const reqStorage of request.storage) {
                    const reqPath = tryRealpathSync(sys, reqStorage.path) || reqStorage.path;
                    if (reqPath === isolatePath || reqPath.startsWith(isolatePath + "/")) {
                        const nonIsolatedBindings = request.bindings.filter(b => {
                            for (let j = 0; j < allConfigs.length; j++) {
                                if (allConfigs[j].config.bindings?.[b]) {
                                    return !allConfigs[j].config.bindings?.[b]?.isolate;
                                }
                            }
                            return true; // Unresolved or not marked as isolated
                        });

                        if (request.network.length > 0 || nonIsolatedBindings.length > 0) {
                            printSecurityFatal("Capability Request Denied: Airgap Mutex", {
                                Reason: "Cannot request network or non-isolated bindings when accessing isolated storage.",
                                IsolatedPath: isolatePathRaw,
                                AttemptedStorage: reqStorage.path,
                                SourceDir: sourceDir,
                                RequestorDir: initialConfigDir
                            });
                            throw new SecurityViolationError("Airgap Mutex Violated");
                        }
                    }
                }
            }
        }

        // 2. Capabilities Check (Default or Delegated)
        if (i > 0) {
            const defaultPerms = sourceConfig.permissions || {};
            let delegatedPerms: any = null;

            if (defaultPerms.delegate) {
                const canonicalRequestorDir = tryRealpathSync(sys, initialConfigDir) || initialConfigDir;
                for (const [delegatePathRaw, perms] of Object.entries(defaultPerms.delegate)) {
                    const delegatePath = tryRealpathSync(sys, resolve(sourceDir, delegatePathRaw)) || resolve(sourceDir, delegatePathRaw);
                    if (canonicalRequestorDir === delegatePath || canonicalRequestorDir.startsWith(delegatePath + "/")) {
                        delegatedPerms = perms;
                        break;
                    }
                }
            }

            for (const n of request.network) {
                if (!defaultPerms.network?.includes("*") && !defaultPerms.network?.includes(n) &&
                    !delegatedPerms?.network?.includes("*") && !delegatedPerms?.network?.includes(n)) {
                    printSecurityFatal("Capability Request Denied: Not delegated by parent", { Reason: "Escalating 'network' permissions", Attempted: n, Child: initialConfigDir, Parent: sourceDir });
                    throw new SecurityViolationError(`Escalating 'network' permissions: ${n}`);
                }
            }

            for (const e of request.env) {
                if (!defaultPerms.env?.includes("*") && !defaultPerms.env?.includes(e) &&
                    !delegatedPerms?.env?.includes("*") && !delegatedPerms?.env?.includes(e)) {
                    printSecurityFatal("Capability Request Denied: Not delegated by parent", { Reason: "Escalating 'env' permissions", Attempted: e, Child: initialConfigDir, Parent: sourceDir });
                    throw new SecurityViolationError(`Escalating 'env' permissions: ${e}`);
                }
            }

            for (const b of request.bindings) {
                if (!defaultPerms.bindings?.includes("*") && !defaultPerms.bindings?.includes(b) &&
                    !delegatedPerms?.bindings?.includes("*") && !delegatedPerms?.bindings?.includes(b)) {
                    printSecurityFatal("Capability Request Denied: Not delegated by parent", { Reason: "Escalating 'bindings' permissions", Attempted: b, Child: initialConfigDir, Parent: sourceDir });
                    throw new SecurityViolationError(`Escalating 'bindings' permissions: ${b}`);
                }
            }

            for (const imp of request.import) {
                if (!defaultPerms.import?.includes(imp) && !delegatedPerms?.import?.includes(imp)) {
                    printSecurityFatal("Capability Request Denied: Not delegated by parent", { Reason: "Escalating 'import' permissions", Attempted: imp, Child: initialConfigDir, Parent: sourceDir });
                    throw new SecurityViolationError(`Escalating 'import' permissions: ${imp}`);
                }
            }

            if (request.gpu && !defaultPerms.gpu && !delegatedPerms?.gpu) {
                printSecurityFatal("Capability Request Denied: Not delegated by parent", { Reason: "Escalating 'gpu' permissions", Attempted: "true", Child: initialConfigDir, Parent: sourceDir });
                throw new SecurityViolationError("Escalating 'gpu' permissions");
            }
            if (request.webrtc && !defaultPerms.webrtc && !delegatedPerms?.webrtc) {
                printSecurityFatal("Capability Request Denied: Not delegated by parent", { Reason: "Escalating 'webrtc' permissions", Attempted: "true", Child: initialConfigDir, Parent: sourceDir });
                throw new SecurityViolationError("Escalating 'webrtc' permissions");
            }

            const parentStorageAbs = Object.entries(defaultPerms.storage || {}).map(([k, v]: [string, any]) => ({ path: resolve(sourceDir, k), access: v.access }));
            const delegatedStorageAbs = Object.entries(delegatedPerms?.storage || {}).map(([k, v]: [string, any]) => ({ path: resolve(sourceDir, k), access: v.access }));
            const combinedAllowedStorage = [...parentStorageAbs, ...delegatedStorageAbs];

            for (const reqStore of request.storage) {
                let covered = false;
                for (const allowedStore of combinedAllowedStorage) {
                    if (reqStore.path === allowedStore.path || reqStore.path.startsWith(allowedStore.path + "/")) {
                        if (reqStore.access === "write" && allowedStore.access !== "write") {
                            continue;
                        }
                        covered = true;
                        break;
                    }
                }
                if (!covered) {
                    printSecurityFatal("Capability Request Denied: Not delegated by parent", { Reason: "Escalating 'storage' permissions", Attempted: reqStore.path, Child: initialConfigDir, Parent: sourceDir });
                    throw new SecurityViolationError(`Escalating 'storage' permissions: ${reqStore.path}`);
                }
            }

            if (sourceConfig.limits) {
                if (sourceConfig.limits.timeoutMillis !== undefined && targetConfig.config.limits?.timeoutMillis !== undefined && targetConfig.config.limits.timeoutMillis > sourceConfig.limits.timeoutMillis) {
                    printSecurityFatal("Capability Request Denied: Exceeds parent limits", { Reason: "Escalating 'timeoutMillis' limit", Child: initialConfigDir, Parent: sourceDir });
                    throw new SecurityViolationError("Escalating 'timeoutMillis' limit");
                }
                if (sourceConfig.limits.memoryMB !== undefined && targetConfig.config.limits?.memoryMB !== undefined && targetConfig.config.limits.memoryMB > sourceConfig.limits.memoryMB) {
                    printSecurityFatal("Capability Request Denied: Exceeds parent limits", { Reason: "Escalating 'memoryMB' limit", Child: initialConfigDir, Parent: sourceDir });
                    throw new SecurityViolationError("Escalating 'memoryMB' limit");
                }
            }
        }
    }

    for (let i = allConfigs.length - 1; i >= 0; i--) {
        const cfg = allConfigs[i].config;
        const dir = allConfigs[i].dir;

        if (cfg.bindings) {
            for (const [k, v] of Object.entries(cfg.bindings) as [string, any][]) {
                if (request.bindings.includes(k)) {
                    const entry = { ...v };
                    if (entry.module && typeof entry.module === "string") {
                        entry.module = resolve(dir, entry.module);
                    }
                    finalConfig.bindings![k] = entry;
                }
            }
        }

        if (cfg.aliases) {
            for (const [k, v] of Object.entries(cfg.aliases)) {
                finalConfig.aliases![k] = resolve(dir, v);
            }
        }

        if (cfg.locations) {
            for (const [k, v] of Object.entries(cfg.locations)) {
                const resolvedKey = resolve(dir, k);
                const resolvedValue = { ...v };
                if (resolvedValue.importMap) {
                    resolvedValue.importMap = resolve(dir, resolvedValue.importMap);
                }
                finalConfig.locations![resolvedKey] = resolvedValue;
            }
        }

        if (cfg.importMap) {
            importMapPaths.push(resolve(dir, cfg.importMap));
        }

        if (cfg.limits) {
            if (cfg.limits.timeoutMillis !== undefined) {
                finalConfig.limits!.timeoutMillis = finalConfig.limits!.timeoutMillis === undefined
                    ? cfg.limits.timeoutMillis
                    : Math.min(finalConfig.limits!.timeoutMillis, cfg.limits.timeoutMillis);
            }
            if (cfg.limits.memoryMB !== undefined) {
                finalConfig.limits!.memoryMB = finalConfig.limits!.memoryMB === undefined
                    ? cfg.limits.memoryMB
                    : Math.min(finalConfig.limits!.memoryMB, cfg.limits.memoryMB);
            }
        }
    }

    return { config: finalConfig, configDir: initialConfigDir, configFound: true, configPaths: allConfigs.map(c => c.path), importMapPaths };
}

export function buildNodeSinkholeDependencies(sys: PolicyRuntime, isolatedTmp: string, importMapPaths: string[] = []): string {
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

// =========================================================
// Safety boundary validation
// =========================================================

export function validateSandboxSafetyBoundaries(sys: PolicyRuntime, policy: EnclavePolicy, cwd: string, protectedFiles: string[], allowedWriteEnclaves: string[]) {
    for (const allowed of allowedWriteEnclaves) {
        const canonicalAllowed = tryRealpathSync(sys, allowed) || allowed;

        for (const rawProtectedFile of protectedFiles) {
            const protectedFile = tryRealpathSync(sys, rawProtectedFile) || rawProtectedFile;
            if (protectedFile === canonicalAllowed || protectedFile.startsWith(canonicalAllowed + "/")) {
                printSecurityFatal("The webrun file is within a permitted write directory. Refusing to run.", {
                    Executable: protectedFile,
                    Permitted: canonicalAllowed
                });
                throw new SecurityViolationError("Executable in write directory");
            }
        }
    }

    if (!policy.isPwdAllowed && !policy.fallbackToTemp) {
        printSecurityFatal("The working directory is not granted read access in webrun.json storage permissions.", {
            Directory: cwd
        });
        throw new SecurityViolationError("Working directory not readable");
    }
}
