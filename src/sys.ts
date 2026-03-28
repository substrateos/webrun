

// =========================================================
// Parameterized utilities — accept structural sys subsets
// =========================================================

export function tryRealpathSync(sys: { realPathSync(p: string): string }, p: string): string | undefined {
    try { return sys.realPathSync(p); } catch { return undefined; }
}

export function tryRemoveSync(sys: { removeSync(p: string, options?: { recursive?: boolean }): void }, p: string, options?: { recursive?: boolean }): void {
    try { sys.removeSync(p, options); } catch { /* Ignored */ }
}

export function tryStatSync(sys: { statSync(p: string): { isFile: boolean, isDirectory: boolean, isSymlink: boolean } }, p: string): { isFile: boolean, isDirectory: boolean, isSymlink: boolean } | undefined {
    try { return sys.statSync(p); } catch { return undefined; }
}


/**
 * Resolves the canonical webrun entry point URL from any src/*.ts module.
 * From source: navigates to ../webrun.ts. From bundle: returns the caller URL itself.
 */
export function resolveWebrunEntryUrl(callerUrl: string): string {
    return callerUrl.endsWith(".ts")
        ? new URL("../webrun.ts", callerUrl).href
        : callerUrl;
}

/** Resolves the canonical webrun entry path (filesystem, not URL). */
export function resolveWebrunEntryPath(sys: { realPathSync(p: string): string }, callerUrl: string): string {
    const url = new URL(resolveWebrunEntryUrl(callerUrl));
    return url.protocol === "file:"
        ? (tryRealpathSync(sys, url.pathname) || url.pathname)
        : url.href;
}
