// =========================================================
// IMPORT MAP: Scoped sinkhole, trusted passthrough, merge
// =========================================================
//
// Host-only module. Builds the import map that the sandbox
// subprocess receives via --import-map.
//
// Architecture: INVERTED SINKHOLE
//
// Deno's import map applies to ALL module resolution, including
// its own internal node compat layer (ext:deno_node/). A global
// sinkhole for node:net breaks node:https (which internally
// imports node:net). Instead we:
//
// 1. Leave global imports empty — Deno internals resolve freely.
// 2. Scope "file:///" — sinkhole dangerous node:* for ALL
//    file-based modules (covers guest code by default).
// 3. Trusted scopes — passthrough overrides for webrun internals
//    (worker blob, werift bundle, webrun source tree).

// Let's make sinkhole uri unique for each node module
const sinkhole = (name: string) => `data:text/javascript,export default null; throw new Error('Security Error: import of "${name}" is blocked.');`;

/** Dangerous node:* modules that are sinkholes for untrusted code. */
export function buildSinkholeImports(): Record<string, string> {
    return {
        "node:fs": sinkhole("node:fs"),
        "node:child_process": sinkhole("node:child_process"),
        "node:dgram": sinkhole("node:dgram"),
        "node:net": sinkhole("node:net"),
        "node:os": sinkhole("node:os"),
        "node:path": sinkhole("node:path"),
        "node:vm": sinkhole("node:vm"),
        "node:crypto": sinkhole("node:crypto"),
    };
}

/** Node modules that trusted scopes may import. */
const nodePassthrough: Record<string, string> = {
    "node:net": "node:net",
    "node:os": "node:os",
    "node:fs": "node:fs",
    "node:path": "node:path",
    "node:crypto": "node:crypto",
    "node:events": "node:events",
    "node:timers/promises": "node:timers/promises",
    "node:tls": "node:tls",
    "node:http": "node:http",
    "node:https": "node:https",
    "node:module": "node:module",
    "node:perf_hooks": "node:perf_hooks",
    "node:dgram": sinkhole("node:dgram"),
};

/**
 * Builds scopes for trusted internal code that needs node:* passthrough.
 *
 * All paths are resolved relative to import.meta.url so they work in
 * both source mode (file:// to .ts files) and bundled mode (compiled
 * binary's embedded module URLs).
 */
function buildTrustedScopes(workerPath?: string): Record<string, Record<string, string>> {
    const scopes: Record<string, Record<string, string>> = {};

    // Worker blob — bundled extensions (serve, direct_sockets) do
    // dynamic import("node:*") from inside the worker blob.
    if (workerPath) {
        const workerDir = workerPath.substring(0, workerPath.lastIndexOf("/")) || "/";
        scopes[new URL(workerDir + "/", "file:///").href] = nodePassthrough;
    } else {
        // Fallback: resolve relative to this module (source tree layout).
        const base = import.meta.url;
        scopes[new URL("../../../sandbox/adapters/deno/", base).href] = nodePassthrough;
    }

    // blob:null/ — dynamic code within the worker (e.g. patched
    // child Worker constructors created by scrub)
    scopes["blob:null/"] = nodePassthrough;

    return scopes;
}

/**
 * Composes all import map concerns into a single map.
 *
 * Global imports are empty — no sinkhole at the top level.
 * The sinkhole lives at the "file:///" scope so it covers all
 * file-based modules by default. Trusted scopes override with
 * passthrough to allow webrun internals to use node:* freely.
 */
export function generateBaseImportMap(workerPath?: string): any {
    return {
        imports: {},
        scopes: {
            "file:///": buildSinkholeImports(),
            ...buildTrustedScopes(workerPath),
        },
    };
}

export function rewriteImportMapPathsToAbsolute(userMap: any, baseDir: string): void {
    const rewriteToAbsolute = (obj: Record<string, string>) => {
        if (!obj) return;
        for (const [key, value] of Object.entries(obj)) {
            if (value.startsWith("./") || value.startsWith("../")) {
                let resolved = "file://" + new URL(value, "file://" + baseDir + (baseDir.endsWith("/") ? "" : "/")).pathname;
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
                resolvedScopeKey = "file://" + new URL(scopeKey, "file://" + baseDir + (baseDir.endsWith("/") ? "" : "/")).pathname;
                if (scopeKey.endsWith("/") && !resolvedScopeKey.endsWith("/")) {
                    resolvedScopeKey += "/";
                }
            }
            newScopes[resolvedScopeKey] = scopeValue;
        }
        userMap.scopes = newScopes;
    }
}

/** Keys that user import maps must never override (in any scope or global imports). */
const PROTECTED_KEYS = new Set([
    ...Object.keys(buildSinkholeImports()),
]);

/** Scopes that user import maps must never modify. */
const PROTECTED_SCOPES = new Set(["file:///"]);

export function mergeImportMaps(targetMap: any, sourceMap: any): void {
    if (sourceMap.imports) {
        for (const [key, value] of Object.entries(sourceMap.imports)) {
            if (PROTECTED_KEYS.has(key)) continue;
            targetMap.imports[key] = value;
        }
    }
    if (sourceMap.scopes) {
        for (const [scopeKey, scopeValue] of Object.entries(sourceMap.scopes)) {
            if (PROTECTED_SCOPES.has(scopeKey)) continue;
            if (!targetMap.scopes[scopeKey]) {
                targetMap.scopes[scopeKey] = {};
            }
            Object.assign(targetMap.scopes[scopeKey], scopeValue);
        }
    }
}

import { readTextFile } from "../../core/io.ts";

export async function buildNodeSinkholeDependencies(rootDir: FileSystemDirectoryHandle, importMapPaths: string[] = []): Promise<Record<string, unknown>> {
    const importMapPayload = generateBaseImportMap();
    for (const absMapPath of importMapPaths) {
        const userMap = JSON.parse(await readTextFile(rootDir, absMapPath.split('/').filter(Boolean)));
        rewriteImportMapPathsToAbsolute(userMap, absMapPath.substring(0, absMapPath.lastIndexOf("/")) || "/");
        mergeImportMaps(importMapPayload, userMap);
    }
    return importMapPayload;
}
