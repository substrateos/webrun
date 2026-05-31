// meta.ts — Context meta: import map resolution (ctx.meta).
//
// Implements the WHATWG import map resolution algorithm for ctx.meta.resolve().
// Pure function — no runtime dependencies.

import type { ImportMap } from "./types.ts";

/** True when the specifier looks like a URL (has a scheme). */
function isAbsolute(specifier: string): boolean {
    try { new URL(specifier); return true; }
    catch { return false; }
}

/** True for specifiers starting with ./ or ../ or / */
function isRelative(specifier: string): boolean {
    return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

/**
 * Attempt to resolve a specifier against a set of import map entries.
 * Returns the resolved URL string, or null if no entry matches.
 *
 * Resolution order (per WHATWG spec):
 * 1. Exact match
 * 2. Longest matching prefix (keys ending with "/")
 */
function resolveFromEntries(
    specifier: string,
    entries: Record<string, string>,
    baseUrl: string,
): string | null {
    // 1. Exact match.
    if (specifier in entries) {
        const mapped = entries[specifier];
        // The mapped value may itself be relative — resolve against base.
        return isAbsolute(mapped) ? mapped : new URL(mapped, baseUrl).href;
    }

    // 2. Longest prefix match (trailing-slash keys).
    let bestKey = "";
    for (const key of Object.keys(entries)) {
        if (!key.endsWith("/")) continue;
        if (specifier.startsWith(key) && key.length > bestKey.length) {
            bestKey = key;
        }
    }
    if (bestKey) {
        const suffix = specifier.slice(bestKey.length);
        const mapped = entries[bestKey];
        const base = isAbsolute(mapped) ? mapped : new URL(mapped, baseUrl).href;
        return base + suffix;
    }

    return null;
}

/**
 * Resolve a module specifier against a base URL, consulting an import map.
 *
 * Follows the WHATWG import map resolution algorithm:
 * 1. Check scoped imports (most-specific scope first)
 * 2. Check top-level imports (exact match, then prefix match)
 * 3. Fall back to URL resolution against base
 */
export function resolveSpecifier(
    specifier: string,
    baseUrl: string,
    importMap?: ImportMap,
): string {
    // Absolute URLs pass through — no import map consultation needed.
    if (isAbsolute(specifier)) return specifier;

    // Relative specifiers bypass the import map — resolve directly.
    if (isRelative(specifier)) return new URL(specifier, baseUrl).href;

    // Bare specifiers: consult the import map.
    if (importMap) {
        // 1. Scoped resolution: find matching scopes sorted by specificity (longest first).
        if (importMap.scopes) {
            const matchingScopes = Object.keys(importMap.scopes)
                .filter(scope => baseUrl.startsWith(scope))
                .sort((a, b) => b.length - a.length);

            for (const scope of matchingScopes) {
                const result = resolveFromEntries(specifier, importMap.scopes[scope], baseUrl);
                if (result !== null) return result;
            }
        }

        // 2. Top-level imports.
        if (importMap.imports) {
            const result = resolveFromEntries(specifier, importMap.imports, baseUrl);
            if (result !== null) return result;
        }
    }

    // 3. Fallback: resolve as URL against base.
    // For bare specifiers without a match, this produces a relative resolution
    // (e.g., "unknown" against "file:///project/main.ts" → "file:///project/unknown").
    return new URL(specifier, baseUrl).href;
}

/**
 * Build a ctx.meta object from a resolved target URL and import map.
 */
export function makeMeta(
    url: string,
    importMap?: ImportMap,
    cwd?: string,
): { url: string; cwd: string; resolve: (specifier: string) => string } {
    const cwdUrl = cwd ? (cwd.startsWith("file://") ? cwd : `file://${cwd}/`) : url;
    return {
        url,
        cwd: cwdUrl,
        resolve: (specifier: string) => resolveSpecifier(specifier, url, importMap),
    };
}
