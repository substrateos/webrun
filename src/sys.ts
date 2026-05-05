// =========================================================
// Shared system utilities — single definitions for helpers
// that were previously duplicated across host.ts, jail.ts,
// and policy.ts.
// =========================================================

/** Resolves a path to its canonical form, returning undefined on failure. */
export function tryRealpathSync(
    sys: { realPathSync(p: string): string },
    path: string,
): string | undefined {
    try { return sys.realPathSync(path); } catch { return undefined; }
}

/** Stats a path, returning undefined if it doesn't exist. */
export function tryStatSync(
    sys: { statSync(p: string): { isFile: boolean; isDirectory: boolean; isSymlink: boolean } },
    path: string,
): { isFile: boolean; isDirectory: boolean; isSymlink: boolean } | undefined {
    try { return sys.statSync(path); } catch { return undefined; }
}

/** Removes a path, silently ignoring errors. */
export function tryRemoveSync(
    sys: { removeSync(p: string, options?: { recursive?: boolean }): void },
    path: string,
    options?: { recursive?: boolean },
): void {
    try { sys.removeSync(path, options); } catch { /* Ignored */ }
}

/**
 * Resolves the webrun entry path from a caller's import.meta.url.
 * In source mode (.ts), resolves webrun.ts relative to this module (sys.ts lives in src/).
 * In bundled mode, callerUrl IS the entry path.
 */
export function resolveWebrunEntryPath(sys: { realPathSync(p: string): string }, callerUrl: string): string {
    const url = new URL(callerUrl.endsWith(".ts") ? new URL("../webrun.ts", import.meta.url).href : callerUrl);
    return url.protocol === "file:" ? (tryRealpathSync(sys, url.pathname) || url.pathname) : url.href;
}

/**
 * Resolves the XDG-compliant webrun cache root directory.
 * Matches the bash wrapper: ${XDG_CACHE_HOME:-$HOME/.cache}/webrun
 *
 * Layout:
 *   <root>/deno/      — the managed Deno binary
 *   <root>/modules/   — Deno module cache (keyed by UA hash)
 */
export function resolveWebrunCacheRoot(
    env: { get(key: string): string | undefined },
): string {
    const { resolve } = await_free_resolve();
    const xdgCache = env.get("XDG_CACHE_HOME")
        || resolve(env.get("HOME") || "/tmp", ".cache");
    return resolve(xdgCache, "webrun");
}


// Inline path.resolve without async import — avoids top-level await.
function await_free_resolve(): { resolve(...paths: string[]): string } {
    // Use the same resolve already imported by consumers. This module
    // can't import it directly without creating a circular dep, so we
    // implement a minimal join+normalize inline.
    return {
        resolve(...paths: string[]): string {
            let resolved = "";
            for (let i = paths.length - 1; i >= 0; i--) {
                const p = paths[i];
                if (!p) continue;
                resolved = resolved ? p + "/" + resolved : p;
                if (p.startsWith("/")) break;
            }
            // Normalize //  and trailing /
            const parts = resolved.split("/").filter(Boolean);
            const stack: string[] = [];
            for (const part of parts) {
                if (part === "..") { stack.pop(); }
                else if (part !== ".") { stack.push(part); }
            }
            return (resolved.startsWith("/") ? "/" : "") + stack.join("/");
        },
    };
}
