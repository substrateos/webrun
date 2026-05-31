/**
 * makeStdIO — Deno adapter for standard I/O streams.
 *
 * Wraps Deno's stdin/stdout/stderr into the platform-neutral stdio shape.
 * Absorbs the resilient stdin stream construction internally.
 */

import createResilientStdinStream from "./stdin.ts";

interface StdioDeps {
    stdin?: { readable?: ReadableStream; read?: (buf: Uint8Array) => Promise<number | null> };
    stdout?: { writable: WritableStream };
    stderr?: { writable: WritableStream };
}

export default function makeStdIO(deps: StdioDeps): {
    stdin: ReadableStream | null;
    stdout: WritableStream | null;
    stderr: WritableStream | null;
} {
    return {
        stdin: createResilientStdinStream(deps.stdin),
        stdout: deps.stdout?.writable || null,
        stderr: deps.stderr?.writable || null,
    };
}
