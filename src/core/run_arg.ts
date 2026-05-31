// run_arg.ts — RunArg template tag for ctx.run.arg.
//
// Provides a tagged template literal that resolves FileSystem handles to
// URLs and collects them as permission grants for child processes.
//
// Usage:
//   const scriptArg = ctx.run.arg`${scriptFileHandle}`;
//   const flagArg = ctx.run.arg`--dir=${dirHandle}`;
//   await ctx.run(["--test", scriptArg, flagArg], { ... });

const RUN_ARG_BRAND = Symbol.for("webrun.RunArg");

/** True if the value looks like a FileSystem handle (has .kind). */
function isHandle(v: unknown): v is FileSystemDirectoryHandle | FileSystemFileHandle {
    return v !== null && typeof v === "object" &&
        "kind" in (v as any) &&
        ((v as any).kind === "directory" || (v as any).kind === "file");
}

/** A resolved storage grant — carries the resolved path, not the raw handle. */
export interface ResolvedGrant {
    readonly resolvedUrl: string;
    readonly access: "read";
}

/** Opaque tagged argument carrying resolved value + storage grants. */
export interface RunArg {
    readonly [brand: symbol]: true;
    readonly value: string;
    readonly grants: ReadonlyArray<ResolvedGrant>;
}

/** Type guard: distinguishes RunArg from plain string args. */
export function isRunArg(v: unknown): v is RunArg {
    return v !== null && typeof v === "object" && (v as any)[RUN_ARG_BRAND] === true;
}

/** Extract all grants from a mixed array of string | RunArg args. */
export function extractGrants(
    args: (string | RunArg)[],
): ResolvedGrant[] {
    const grants: ResolvedGrant[] = [];
    for (const arg of args) {
        if (isRunArg(arg)) {
            grants.push(...arg.grants);
        }
    }
    return grants;
}

/**
 * Create a ctx.run.arg tagged template function.
 *
 * @param resolveHandle — converts a handle to its file:// URL string.
 */
export function createRunArgTag(
    resolveHandle: (handle: FileSystemDirectoryHandle | FileSystemFileHandle) => string,
): (strings: TemplateStringsArray, ...values: any[]) => RunArg {
    return (strings: TemplateStringsArray, ...values: any[]): RunArg => {
        const grants: ResolvedGrant[] = [];
        let result = strings[0];

        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (isHandle(v)) {
                const url = resolveHandle(v);
                result += url;
                grants.push({ resolvedUrl: url, access: "read" });
            } else {
                result += String(v);
            }
            result += strings[i + 1];
        }

        return {
            [RUN_ARG_BRAND]: true as const,
            value: result,
            grants,
        };
    };
}
