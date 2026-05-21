import type { WebrunConfig, WebrunLocationConfig, WebrunPermissions } from "../types.ts";

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
