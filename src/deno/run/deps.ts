/**
 * DenoRuntime — the subset of Deno APIs that RunDeps needs.
 *
 * Shared between host.ts (CLI entry) and sandbox.ts (nested ctx.run()).
 */

/** The subset of Deno APIs required by the run subsystem. */
export interface DenoRuntime {
    build: { os: string };
    cwd(): string;
    execPath(): string;
    pid: number;
    listen(options: { port: number; hostname?: string }): { addr: { port: number }; close(): void };
    openSync(path: string, options?: { read?: boolean; write?: boolean; create?: boolean; truncate?: boolean }): { writable: WritableStream<Uint8Array>; close(): void };
    realPathSync(path: string): string;
    makeTempDirSync(options?: { prefix?: string, dir?: string }): string;
    mkdirSync(path: string, options?: { recursive?: boolean }): void;
    writeTextFileSync(path: string, data: string): void;
    removeSync(path: string, opts?: { recursive?: boolean }): void;
    stdout: { write(chunk: Uint8Array | string): void; writable: WritableStream<Uint8Array> };
    stderr: { write(chunk: Uint8Array | string): void; writable: WritableStream<Uint8Array> };
    Command: {
        new(cmd: string, opts: {
            args?: string[];
            cwd?: string;
            env?: Record<string, string>;
            stdin?: "piped" | "inherit" | "null";
            stdout?: "piped" | "inherit" | "null";
            stderr?: "piped" | "inherit" | "null";
        }): {
            spawn(): {
                stdin: WritableStream<Uint8Array> | null;
                stdout: ReadableStream<Uint8Array> | null;
                stderr: ReadableStream<Uint8Array> | null;
                kill(signal?: string): void;
                status: Promise<{ code: number }>;
            };
        };
    };
}
