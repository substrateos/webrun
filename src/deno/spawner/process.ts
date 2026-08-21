/**
 * Process management via FFI.
 *
 * Provides posix_spawn with stdio FD mapping, non-blocking waitpid,
 * and kill(2) signal delivery.
 *
 * All Deno FFI surface is injected via makeProcess() — this module
 * contains no ambient Deno global access.
 */

/** Opaque pointer value — structurally bigint | null. */
type PointerValue = bigint | null;

/** The Deno APIs that process management needs. */
export interface ProcessDeps {
    build: { os: string };
    dlopen(
        path: string,
        symbols: Record<string, {
            parameters: readonly string[];
            result: string;
            nonblocking?: boolean;
        }>,
    ): { symbols: Record<string, (...args: any[]) => any> };
    UnsafePointer: {
        of(buf: ArrayBufferView & { buffer: ArrayBuffer }): PointerValue;
        value(ptr: NonNullable<PointerValue>): bigint;
    };
    UnsafePointerView: {
        new(ptr: NonNullable<PointerValue>): { getCString(): string; getInt32(): number };
    };
}

/** Process management API. */
export interface ProcessAPI {
    /** Spawn a child process with the given stdio FDs. */
    spawnWithFds(
        command: string, args: string[], env: Record<string, string>, cwd: string,
        fds: { stdin: number; stdout: number; stderr: number },
    ): {
        pid: number;
        waitNonBlocking(): number | null;
        kill(signal: string): void;
    };
}

const SIGNAL_MAP_DARWIN: Record<string, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15,
    SIGUSR1: 30, SIGUSR2: 31,
};

const SIGNAL_MAP_LINUX: Record<string, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15,
    SIGUSR1: 10, SIGUSR2: 12,
};

export function makeProcess(Deno: ProcessDeps): ProcessAPI {

    const IS_DARWIN = Deno.build.os === "darwin";
    const LIBC_PATH = IS_DARWIN ? "libSystem.B.dylib" : "libc.so.6";
    const SIGNAL_MAP = IS_DARWIN ? SIGNAL_MAP_DARWIN : SIGNAL_MAP_LINUX;

    // ─── Lazy FFI handle ───

    interface LibC {
        close(fd: number): number;
        posix_spawn(pid: PointerValue, path: PointerValue, fileActions: PointerValue, attrp: PointerValue, argv: PointerValue, envp: PointerValue): number;
        posix_spawn_file_actions_init(fileActions: PointerValue): number;
        posix_spawn_file_actions_destroy(fileActions: PointerValue): number;
        posix_spawn_file_actions_adddup2(fileActions: PointerValue, fd: number, newFd: number): number;
        posix_spawn_file_actions_addclose(fileActions: PointerValue, fd: number): number;
        posix_spawn_file_actions_addchdir_np(fileActions: PointerValue, path: PointerValue): number;
        waitpid(pid: number, status: PointerValue, options: number): number;
        kill(pid: number, sig: number): number;
        errno(): number;
        strerror(errnum: number): PointerValue;
    }

    let _libc: LibC | null = null;

    function getLibC(): LibC {
        if (_libc) return _libc;

        const lib = Deno.dlopen(LIBC_PATH, {
            close: { parameters: ["i32"], result: "i32" },
            posix_spawn: { parameters: ["pointer", "pointer", "pointer", "pointer", "pointer", "pointer"], result: "i32" },
            posix_spawn_file_actions_init: { parameters: ["pointer"], result: "i32" },
            posix_spawn_file_actions_destroy: { parameters: ["pointer"], result: "i32" },
            posix_spawn_file_actions_adddup2: { parameters: ["pointer", "i32", "i32"], result: "i32" },
            posix_spawn_file_actions_addclose: { parameters: ["pointer", "i32"], result: "i32" },
            posix_spawn_file_actions_addchdir_np: { parameters: ["pointer", "pointer"], result: "i32" },
            waitpid: { parameters: ["i32", "pointer", "i32"], result: "i32" },
            kill: { parameters: ["i32", "i32"], result: "i32" },
            strerror: { parameters: ["i32"], result: "pointer" },
            ...(IS_DARWIN
                ? { __error: { parameters: [], result: "pointer" } }
                : { __errno_location: { parameters: [], result: "pointer" } }),
        });

        _libc = {
            close: (fd) => lib.symbols.close(fd) as number,
            posix_spawn: (pid, path, fa, attr, argv, envp) => lib.symbols.posix_spawn(pid, path, fa, attr, argv, envp) as number,
            posix_spawn_file_actions_init: (fa) => lib.symbols.posix_spawn_file_actions_init(fa) as number,
            posix_spawn_file_actions_destroy: (fa) => lib.symbols.posix_spawn_file_actions_destroy(fa) as number,
            posix_spawn_file_actions_adddup2: (fa, fd, newFd) => lib.symbols.posix_spawn_file_actions_adddup2(fa, fd, newFd) as number,
            posix_spawn_file_actions_addclose: (fa, fd) => lib.symbols.posix_spawn_file_actions_addclose(fa, fd) as number,
            posix_spawn_file_actions_addchdir_np: (fa, path) => lib.symbols.posix_spawn_file_actions_addchdir_np(fa, path) as number,
            waitpid: (pid, status, options) => lib.symbols.waitpid(pid, status, options) as number,
            kill: (pid, sig) => lib.symbols.kill(pid, sig) as number,
            errno: () => {
                const fn = IS_DARWIN ? lib.symbols.__error : lib.symbols.__errno_location;
                const ptr = fn() as PointerValue;
                return new Deno.UnsafePointerView(ptr!).getInt32();
            },
            strerror: (errnum) => lib.symbols.strerror(errnum) as PointerValue,
        };

        return _libc;
    }

    function errnoMessage(): string {
        const libc = getLibC();
        const e = libc.errno();
        const ptr = libc.strerror(e);
        const msg = ptr ? new Deno.UnsafePointerView(ptr).getCString() : "unknown";
        return `${msg} (errno ${e})`;
    }

    // ─── posix_spawn helpers ───

    function cstr(s: string): Uint8Array<ArrayBuffer> {
        return new TextEncoder().encode(s + "\0") as Uint8Array<ArrayBuffer>;
    }

    function buildCStringArray(strings: string[]): { ptrs: BigUint64Array<ArrayBuffer>; bufs: Uint8Array<ArrayBuffer>[] } {
        const bufs = strings.map(cstr);
        const ptrs = new BigUint64Array(strings.length + 1) as BigUint64Array<ArrayBuffer>;
        for (let i = 0; i < bufs.length; i++) {
            ptrs[i] = BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(bufs[i])!));
        }
        ptrs[strings.length] = 0n;
        return { ptrs, bufs };
    }

    const FILE_ACTIONS_SIZE = 128;
    const WNOHANG = 1;

    function spawnWithFds(
        command: string,
        args: string[],
        env: Record<string, string>,
        cwd: string,
        fds: { stdin: number; stdout: number; stderr: number },
    ): {
        pid: number;
        waitNonBlocking(): number | null;
        kill(signal: string): void;
    } {
        const libc = getLibC();

        const fileActions = new Uint8Array(FILE_ACTIONS_SIZE) as Uint8Array<ArrayBuffer>;
        let rc = libc.posix_spawn_file_actions_init(Deno.UnsafePointer.of(fileActions));
        if (rc !== 0) throw new Error(`posix_spawn_file_actions_init failed: ${rc}`);

        try {
            const mappings: [number, number][] = [
                [fds.stdin, 0],
                [fds.stdout, 1],
                [fds.stderr, 2],
            ];
            for (const [srcFd, dstFd] of mappings) {
                if (srcFd === dstFd) continue;
                rc = libc.posix_spawn_file_actions_adddup2(Deno.UnsafePointer.of(fileActions), srcFd, dstFd);
                if (rc !== 0) throw new Error(`posix_spawn_file_actions_adddup2(${srcFd}, ${dstFd}) failed: ${rc}`);
            }

            const toClose = new Set([fds.stdin, fds.stdout, fds.stderr]);
            for (const fd of toClose) {
                if (fd <= 2) continue;
                rc = libc.posix_spawn_file_actions_addclose(Deno.UnsafePointer.of(fileActions), fd);
                if (rc !== 0) throw new Error(`posix_spawn_file_actions_addclose(${fd}) failed: ${rc}`);
            }

            const cwdBuf = cstr(cwd);
            rc = libc.posix_spawn_file_actions_addchdir_np(Deno.UnsafePointer.of(fileActions), Deno.UnsafePointer.of(cwdBuf));
            if (rc !== 0) throw new Error(`posix_spawn_file_actions_addchdir_np failed: ${rc}`);

            const argv = buildCStringArray([command, ...args]);
            const envStrings = Object.entries(env).map(([k, v]) => `${k}=${v}`);
            const envp = buildCStringArray(envStrings);
            const pathBuf = cstr(command);

            const pidBuf = new Int32Array(1) as Int32Array<ArrayBuffer>;
            const pidArr = new Uint8Array(pidBuf.buffer) as Uint8Array<ArrayBuffer>;
            const argvArr = new Uint8Array(argv.ptrs.buffer) as Uint8Array<ArrayBuffer>;
            const envpArr = new Uint8Array(envp.ptrs.buffer) as Uint8Array<ArrayBuffer>;
            rc = libc.posix_spawn(
                Deno.UnsafePointer.of(pidArr),
                Deno.UnsafePointer.of(pathBuf),
                Deno.UnsafePointer.of(fileActions),
                null,
                Deno.UnsafePointer.of(argvArr),
                Deno.UnsafePointer.of(envpArr),
            );

            if (rc !== 0) {
                throw new Error(`posix_spawn failed: ${rc} (${errnoMessage()})`);
            }

            void argv.bufs;
            void envp.bufs;
            void pathBuf;
            void cwdBuf;

            const pid = pidBuf[0];

            return {
                pid,
                waitNonBlocking(): number | null {
                    const status = new Int32Array(1) as Int32Array<ArrayBuffer>;
                    const result = getLibC().waitpid(pid, Deno.UnsafePointer.of(new Uint8Array(status.buffer) as Uint8Array<ArrayBuffer>), WNOHANG);
                    if (result === -1) {
                        const e = getLibC().errno();
                        throw new Error(`waitpid failed: ${e}`);
                    }
                    if (result === 0) return null;
                    const raw = status[0];
                    const exited = (raw & 0x7f) === 0;
                    const code = exited ? ((raw >> 8) & 0xff) : (128 + (raw & 0x7f));
                    return code;
                },
                /** Send a signal to the child. */
                kill(signal: string): void {
                    const sigNum = SIGNAL_MAP[signal] ?? 15;
                    getLibC().kill(pid, sigNum);
                },
            };

        } finally {
            libc.posix_spawn_file_actions_destroy(Deno.UnsafePointer.of(fileActions));
        }
    }

    // ─── Public API ───

    return { spawnWithFds };

} // makeProcess
