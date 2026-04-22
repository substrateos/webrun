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
