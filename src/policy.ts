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
import { WebrunConfig, PolicyRuntime } from "./types.ts";
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
export function evaluateEnclavePolicy(sys: PolicyRuntime, configDirs: Record<string, { access: "read" | "write" }>, configBindings: string[], configDir: string, currentDir: string, isolatedTmp: string): EnclavePolicy {
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

export function validatePrivilegeNarrowing(sys: PolicyRuntime, parentConfig: WebrunConfig, parentDir: string, childConfig: WebrunConfig, childDir: string) {
    if (parentConfig.limits) {
        if (parentConfig.limits.timeoutMillis !== undefined && childConfig.limits?.timeoutMillis !== undefined && childConfig.limits.timeoutMillis > parentConfig.limits.timeoutMillis) {
            printSecurityFatal("Privilege escalation detected in nested configuration.", {
                Reason: "Escalating 'timeoutMillis' limit",
                Attempted: String(childConfig.limits.timeoutMillis),
                Permitted: String(parentConfig.limits.timeoutMillis),
                Child: childDir,
                Parent: parentDir
            });
            throw new SecurityViolationError("Escalating timeoutMillis");
        }
        if (parentConfig.limits.memoryMB !== undefined && childConfig.limits?.memoryMB !== undefined && childConfig.limits.memoryMB > parentConfig.limits.memoryMB) {
            printSecurityFatal("Privilege escalation detected in nested configuration.", {
                Reason: "Escalating 'memoryMB' limit",
                Attempted: String(childConfig.limits.memoryMB),
                Permitted: String(parentConfig.limits.memoryMB),
                Child: childDir,
                Parent: parentDir
            });
            throw new SecurityViolationError("Escalating memoryMB");
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
            throw new SecurityViolationError(`Escalating env: ${e}`);
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
            throw new SecurityViolationError(`Escalating network: ${n}`);
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
                throw new SecurityViolationError(`Escalating binding: ${bindingName}`);
            }
        }
    }

    if (childConfig.permissions?.imports) {
        const parentImports = parentConfig.permissions?.imports || [];
        for (const i of childConfig.permissions.imports) {
            if (!parentImports.includes(i)) {
                printSecurityFatal("Privilege escalation detected in nested configuration.", {
                    Reason: "Escalating 'imports' permissions",
                    Attempted: i,
                    Child: childDir,
                    Parent: parentDir
                });
                throw new SecurityViolationError(`Escalating imports: ${i}`);
            }
        }
    }

    if (childConfig.permissions?.gpu && !parentConfig.permissions?.gpu) {
        printSecurityFatal("Privilege escalation detected in nested configuration.", {
            Reason: "Escalating 'gpu' permissions",
            Attempted: "true",
            Child: childDir,
            Parent: parentDir
        });
        throw new SecurityViolationError("Escalating gpu");
    }

    if ((childConfig.permissions as any)?.webrtc && !(parentConfig.permissions as any)?.webrtc) {
        printSecurityFatal("Privilege escalation detected in nested configuration.", {
            Reason: "Escalating 'webrtc' permissions",
            Attempted: "true",
            Child: childDir,
            Parent: parentDir
        });
        throw new SecurityViolationError("Escalating webrtc");
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
            throw new SecurityViolationError(`Escalating storage: ${c.path}`);
        }
    }
}

export function mergeConfigurations(sys: PolicyRuntime, allConfigs: FoundConfig[], defaultDir: string): { config: WebrunConfig, configDir: string, configFound: boolean, configPaths: string[], importMapPaths: string[] } {
    const importMapPaths: string[] = [];
    const finalConfig: WebrunConfig = { permissions: { storage: {}, network: [], env: [], bindings: [] } };
    let finalConfigDir = defaultDir;
    let configFound = false;

    if (allConfigs.length > 0) {
        configFound = true;
        const mostSpecific = allConfigs[0];
        finalConfigDir = mostSpecific.dir;

        for (let i = 0; i < allConfigs.length - 1; i++) {
            validatePrivilegeNarrowing(sys, allConfigs[i + 1].config, allConfigs[i + 1].dir, allConfigs[i].config, allConfigs[i].dir);
        }

        Object.assign(finalConfig.permissions!, mostSpecific.config.permissions);

        // Empty storage = no storage (fallback to temp). We no longer inherit
        // parent storage — configs are structurally self-contained.

        if (mostSpecific.config.module) {
            finalConfig.module = mostSpecific.config.module;
        }

        if (mostSpecific.config.experimental) {
            finalConfig.experimental = mostSpecific.config.experimental;
        }

        if (mostSpecific.config.serve) {
            finalConfig.serve = mostSpecific.config.serve;
        }

        // Accumulate bindings, importMaps, and limits from all configs (parent-first order).
        // Bindings: most-specific wins per key (parent-first, child overwrites).
        // ImportMaps: accumulate all (parent-first order).
        // Limits: take the minimum across all levels.
        for (let i = allConfigs.length - 1; i >= 0; i--) {
            const cfg = allConfigs[i].config;
            const dir = allConfigs[i].dir;

            if (cfg.bindings) {
                if (!finalConfig.bindings) finalConfig.bindings = {};
                for (const [k, v] of Object.entries(cfg.bindings) as [string, any][]) {
                    const entry = { ...v };
                    if (entry.module && typeof entry.module === "string") {
                        entry.module = resolve(dir, entry.module);
                    }
                    finalConfig.bindings[k] = entry;
                }
            }

            if (cfg.importMap) {
                importMapPaths.push(resolve(dir, cfg.importMap));
            }

            if (cfg.limits) {
                if (!finalConfig.limits) finalConfig.limits = {};
                if (cfg.limits.timeoutMillis !== undefined) {
                    finalConfig.limits.timeoutMillis = finalConfig.limits.timeoutMillis === undefined
                        ? cfg.limits.timeoutMillis
                        : Math.min(finalConfig.limits.timeoutMillis, cfg.limits.timeoutMillis);
                }
                if (cfg.limits.memoryMB !== undefined) {
                    finalConfig.limits.memoryMB = finalConfig.limits.memoryMB === undefined
                        ? cfg.limits.memoryMB
                        : Math.min(finalConfig.limits.memoryMB, cfg.limits.memoryMB);
                }
            }
        }

        // Prune bindings not listed in permissions.bindings.
        if (finalConfig.bindings && finalConfig.permissions?.bindings) {
            const allowed = finalConfig.permissions.bindings;
            for (const key of Object.keys(finalConfig.bindings)) {
                if (!allowed.includes(key)) {
                    delete finalConfig.bindings[key];
                }
            }
        }
    }

    return { config: finalConfig, configDir: finalConfigDir, configFound, configPaths: allConfigs.map(c => c.path), importMapPaths };
}

export function resolveLocalConfiguration(sys: PolicyRuntime, currentDir: string): { config: WebrunConfig, configDir: string, configFound: boolean, configPaths: string[], importMapPaths: string[] } {
    const allConfigs = findLocalConfigurations(sys, currentDir);
    return mergeConfigurations(sys, allConfigs, currentDir);
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
