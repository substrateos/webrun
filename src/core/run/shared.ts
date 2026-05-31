// shared.ts — Validation and identity for shared runs.
//
// A shared run (`shared: true` in RunOptions) deduplicates by resolved target
// path. The first call spawns the process; subsequent calls return a handle to
// the existing instance. Constraints: shared: true forbids all other options.

/**
 * Validate that a shared run does not specify any parameterization options.
 * Throws TypeError if shared: true and any option other than "shared" is present,
 * or if guest args (post-parsing) are provided.
 */
export function validateSharedOptions(args: string[], options: Record<string, unknown>): void {
    if (!options.shared) return;

    if (args.length > 0) {
        throw new TypeError(
            "shared runs must not specify extra args — only the target is allowed"
        );
    }

    for (const key of Object.keys(options)) {
        if (key !== "shared") {
            throw new TypeError(
                `shared runs must not specify "${key}" — shared: true forbids all other options`
            );
        }
    }
}

/**
 * Compute the deduplication key for a shared run.
 * Identity is the resolved target path — matches SharedWorker's URL-based identity.
 */
export function sharedKey(resolvedTarget: string): string {
    return resolvedTarget;
}
