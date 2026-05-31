/**
 * Replaces the current process image via execvp(3).
 *
 * Used by binary-mode sandbox execution — after the OS jail is applied,
 * the sandbox exec's the target binary so the jail restrictions are
 * inherited by the new process image.
 *
 * All runtime FFI types are injected via makeExec() — this module
 * contains no ambient Deno global access.
 */

// ── Structural dependency types ─────────────────────────────────────────────

/** Opaque pointer value used by FFI — structurally bigint | null. */
type PointerValue = bigint | null;

/** The subset of UnsafePointer this module actually calls. */
interface UnsafePointerAPI {
    of(buf: Uint8Array<ArrayBuffer>): PointerValue;
    value(ptr: NonNullable<PointerValue>): bigint;
}

/** Spec for a single foreign function symbol. */
interface ForeignFunctionSpec {
    parameters: readonly string[];
    result: string;
}

/** The runtime APIs that exec actually needs. */
export interface ExecDeps {
    dlopen(
        path: string,
        symbols: Record<string, ForeignFunctionSpec>,
    ): { symbols: Record<string, (...args: any[]) => any> };
    UnsafePointer: UnsafePointerAPI;
    build: { os: string };
    exit(code: number): never;
}

// ── Factory ─────────────────────────────────────────────────────────────────

export default function makeExec(deps: ExecDeps): (...argv: string[]) => never {
    return function exec(...argv: string[]): never {
        const libcPath = deps.build.os === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
        const libc = deps.dlopen(libcPath, {
            execvp: { parameters: ["pointer", "pointer"], result: "i32" },
        });

        const encode = (s: string): Uint8Array => new TextEncoder().encode(s + "\0");
        const file = encode(argv[0]);

        // Build char *argv[] — array of pointers to null-terminated strings, NULL-terminated.
        const ptrs = new BigUint64Array(argv.length + 1);
        const buffers: Uint8Array[] = [];
        for (let i = 0; i < argv.length; i++) {
            const buf = new Uint8Array(encode(argv[i]).buffer) as Uint8Array<ArrayBuffer>;
            buffers.push(buf);
            ptrs[i] = BigInt(deps.UnsafePointer.value(deps.UnsafePointer.of(buf)!));
        }
        ptrs[argv.length] = 0n; // NULL terminator

        const result = libc.symbols.execvp(
            deps.UnsafePointer.of(new Uint8Array(file.buffer) as Uint8Array<ArrayBuffer>),
            deps.UnsafePointer.of(new Uint8Array(ptrs.buffer) as Uint8Array<ArrayBuffer>),
        );

        // If we get here, execvp failed.
        const err = `Fatal: execvp failed for binding: ${argv[0]} with result ${result}`;
        console.error(`[webrun] ${err}`);
        deps.exit(127);
    };
}
