import type { WebrunConfig, WebrunLocationConfig, ImportMap } from "./types.ts";
import { resolveStoragePaths } from "./types.ts";
import { resolveDirectoryHandle } from "./io.ts";

/**
 * Represents a parsed configuration block from a specific directory level.
 * Configs are chained together (from the execution target up to the root)
 * to form the capability boundaries and aliases.
 */
export interface LocalConfig {
    /** Directory this configuration applies to. */
    dir: FileSystemDirectoryHandle;
    file?: FileSystemFileHandle;
    config: WebrunConfig;
    importMap?: ImportMap;
    locationConfig: WebrunLocationConfig;
    protectedFiles: FileSystemFileHandle[];
}

/**
 * Walks up the directory tree from the target path to the root, parsing all `webrun.json` files.
 * The resulting array is ordered from child (target) to parent (root).
 * Missing directories or unreadable configs are skipped gracefully.
 */
export async function findLocalConfigurations(rootDir: FileSystemDirectoryHandle, pathParts: readonly string[]): Promise<LocalConfig[]> {
    let configParts = [...pathParts];
    const localConfigs: LocalConfig[] = [];

    while (true) {
        let dirHandle: FileSystemDirectoryHandle;
        try {
            dirHandle = await resolveDirectoryHandle(rootDir, configParts);
        } catch (e: any) {
            // Skip directories we can't read (missing or no permission)
            if (configParts.length === 0) break;
            configParts.pop();
            continue;
        }

        let fileHandle: FileSystemFileHandle
        let config: WebrunConfig
        try {
            fileHandle = await dirHandle.getFileHandle("webrun.json", { create: false });
            const file = await fileHandle.getFile();
            config = JSON.parse(await file.text());
        } catch (e: any) {
            if (e.name === "NotFoundError" || e.name === "NotCapable" || e.name === "PermissionDenied") {
                if (configParts.length === 0) break;
                configParts.pop();
                continue;
            }
            throw e
        }

        const protectedFiles: FileSystemFileHandle[] = [fileHandle];

        let importMap: ImportMap | undefined;
        if (config.importMap) {
            const mapHandle = await dirHandle.getFileHandle(config.importMap, { create: false });
            const mapFile = await mapHandle.getFile();
            importMap = JSON.parse(await mapFile.text());
            protectedFiles.push(mapHandle);
        }

        if (config.locations) {
            for (const value of Object.values(config.locations || {})) {
                if (value.importMap) {
                    protectedFiles.push(await dirHandle.getFileHandle(value.importMap, { create: false }));
                }
            }
        }

        localConfigs.push({
            dir: dirHandle,
            file: fileHandle,
            config,
            importMap,
            locationConfig: config,
            protectedFiles,
        });

        if (configParts.length === 0) break;
        configParts.pop();
    }

    return localConfigs;
}

export function isBareCommand(loc: string): boolean {
    return !loc.includes("/") && !/^[a-z]+:/i.test(loc);
}

/** Resolve a location string to an absolute path against cwd. URLs pass through. */
export function resolveLocation(loc: string, cwd: string): string {
    if (/^[a-z]+:/i.test(loc)) return loc;
    if (loc.startsWith("/")) return loc;
    return new URL(loc, "file://" + cwd + (cwd.endsWith("/") ? "" : "/")).pathname;
}

/**
 * Resolve an execution target through the config chain's aliases.
 * Looks up `name` (or "default" if empty) across all configs.
 * Returns undefined if no alias matches.
 */
export function resolveTarget(
    name: string,
    configs: readonly Readonly<LocalConfig>[],
    resolveDir: (h: FileSystemDirectoryHandle) => string,
): string | undefined {
    const key = name || "default";
    for (const cfg of configs) {
        const alias = cfg.config.aliases?.[key];
        if (alias) return resolveLocation(alias, resolveDir(cfg.dir));
    }
    return undefined;
}

/**
 * Flatten the config chain's aliases into a single resolved map.
 * Inner (child-first) entries shadow outer (parent) entries — lexical scope.
 * All values are resolved to absolute paths against their declaring config's dir.
 */
export function resolveAllAliases(
    configs: readonly Readonly<LocalConfig>[],
    resolveDir: (h: FileSystemDirectoryHandle) => string,
): Record<string, string> {
    const aliases: Record<string, string> = {};
    // Walk parent-first so child entries overwrite parent entries.
    for (let i = configs.length - 1; i >= 0; i--) {
        const cfg = configs[i];
        const dir = resolveDir(cfg.dir);
        for (const [key, value] of Object.entries(cfg.config.aliases || {})) {
            aliases[key] = resolveLocation(value, dir);
        }
    }
    return aliases;
}

/**
 * An extension of LocalConfig used when resolving nested `locations` rules
 * within a `webrun.json`.
 */
export interface LocalLocationConfig extends LocalConfig {
    /** The specific location key that matched the target path. */
    locationKey?: string;
}

/**
 * Resolves matching location entries across the entire config chain for a target path.
 * For each config, the config itself is included, followed by any matching location
 * entries as LocalLocationConfigs. Returns the full chain (child first, parent last).
 */
export async function resolveLocationChain(
    resolvedTargetLocation: string | undefined,
    localConfigs: readonly Readonly<LocalConfig>[],
    resolveDir: (h: FileSystemDirectoryHandle) => string,
): Promise<LocalLocationConfig[]> {
    const chain: LocalLocationConfig[] = [];

    for (const cfg of localConfigs) {
        chain.push(cfg);

        if (!cfg.config.locations || !resolvedTargetLocation) continue;

        const dir = resolveDir(cfg.dir);
        for (const [locPath, locConfig] of Object.entries(cfg.config.locations)) {
            // Resolve the location key: if it matches an alias, use the alias target.
            const aliasedPath = cfg.config.aliases?.[locPath] ?? locPath;
            const resolvedKey = resolveLocation(aliasedPath, dir);
            const isPrefix = resolvedKey.endsWith("/") && resolvedTargetLocation.startsWith(resolvedKey);
            const isExact = resolvedTargetLocation === resolvedKey;
            if (isPrefix || isExact) {
                let importMap: ImportMap | undefined;
                if (typeof locConfig === "object" && locConfig.importMap) {
                    const mapHandle = await cfg.dir.getFileHandle(locConfig.importMap, { create: false });
                    const mapFile = await mapHandle.getFile();
                    importMap = JSON.parse(await mapFile.text());
                }

                chain.push({
                    locationKey: locPath,
                    dir: cfg.dir,
                    file: cfg.file,
                    importMap,
                    config: cfg.config,
                    locationConfig: typeof locConfig === "object" ? locConfig : cfg.locationConfig,
                    protectedFiles: [],
                });
            }
        }
    }
    return chain;
}

// =========================================================
// Configuration merging
// =========================================================

/**
 * The fully merged result of a configuration chain, collapsing all parent
 * and child settings into a final execution profile.
 */
export interface MergedConfig {
    /** The ultimate target directory executing the app. */
    dir: FileSystemDirectoryHandle;
    file?: FileSystemFileHandle;
    config: WebrunLocationConfig;
    importMap: ImportMap;
    protectedFiles: FileSystemFileHandle[];
}

/**
 * Merges a hierarchical config chain into a single MergedConfig.
 * Import map entries are resolved to absolute paths using resolveDir + resolveLocation.
 */
export function mergeConfigurations(
    localConfigs: readonly Readonly<LocalConfig>[],
    resolveDir: (h: FileSystemDirectoryHandle) => string,
): MergedConfig {
    const targetConfig = localConfigs[0];

    const mergedConfig: WebrunLocationConfig = {
        permissions: {},
        limits: {},
    };

    const imports: Record<string, string> = {};
    const scopes: Record<string, Record<string, string>> = {};

    for (let i = localConfigs.length - 1; i >= 0; i--) {
        const lc = localConfigs[i];
        const cfg = lc.locationConfig;
        const dir = resolveDir(lc.dir);

        if (cfg.permissions) {
            // Non-storage permissions cascade normally (child-wins via spread).
            // Storage is excluded — it does NOT cascade (handled below).
            const { storage: _storage, ...otherPerms } = cfg.permissions;
            mergedConfig.permissions = { ...mergedConfig.permissions, ...otherPerms };
        }

        if (cfg.limits) {
            mergedConfig.limits = { ...mergedConfig.limits, ...cfg.limits };
        }

        if (cfg.extensions) {
            mergedConfig.extensions = { ...mergedConfig.extensions, ...cfg.extensions };
        }

        if (cfg.dir) {
            mergedConfig.dir = resolveLocation(cfg.dir, dir);
        }

        if (cfg.portEnv) {
            mergedConfig.portEnv = cfg.portEnv;
        }

        if (lc.importMap) {
            if (lc.importMap.imports) {
                for (const [k, v] of Object.entries(lc.importMap.imports)) {
                    imports[k] = resolveLocation(v, dir);
                }
            }
            if (lc.importMap.scopes) {
                for (const [scopeKey, scopeValue] of Object.entries(lc.importMap.scopes)) {
                    // Relative keys are resolved against the directory of the webrun.json
                    // that declared the importMap — not the import map file itself.
                    let resolvedKey = scopeKey;
                    if (scopeKey.startsWith("./") || scopeKey.startsWith("../")) {
                        resolvedKey = "file://" + resolveLocation(scopeKey, dir);
                    }
                    if (!scopes[resolvedKey]) scopes[resolvedKey] = {};
                    for (const [k, v] of Object.entries(scopeValue)) {
                        scopes[resolvedKey][k] = resolveLocation(v, dir);
                    }
                }
            }
        }
    }

    const protectedFiles = localConfigs.flatMap(c => c.protectedFiles)

    // Storage is a capability grant — only the target config's own storage is used.
    // Parent storage is the parent's own capability, never inherited by the child.
    const targetStorage = targetConfig.locationConfig.permissions?.storage;
    if (targetStorage) {
        mergedConfig.permissions = {
            ...mergedConfig.permissions,
            storage: resolveStoragePaths(targetStorage, resolveDir(targetConfig.dir))
        };
    }

    return {
        dir: targetConfig.dir,
        file: targetConfig.file,
        config: mergedConfig,
        importMap: { imports, scopes },
        protectedFiles,
    };
}

