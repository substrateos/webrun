/**
 * Landlock FFI — Linux kernel self-sandboxing via Deno.dlopen.
 *
 * Applies Landlock restrictions to the current process before any untrusted
 * code executes. The restrictions are irreversible and inherited by child
 * processes and threads.
 *
 * Requires Linux kernel >= 5.13 with CONFIG_SECURITY_LANDLOCK=y.
 */

import type { LandlockPolicy } from "./types.ts";

// ─── Syscall numbers (stable across x86_64 and aarch64) ───
const SYS_landlock_create_ruleset = 444;
const SYS_landlock_add_rule = 445;
const SYS_landlock_restrict_self = 446;

// ─── Landlock constants ───

// Rule types
const LANDLOCK_RULE_PATH_BENEATH = 1;
const LANDLOCK_RULE_NET_PORT = 2;

// Landlock ABI 1 filesystem access flags (kernel 5.13+)
const LANDLOCK_ACCESS_FS_EXECUTE      = 1n << 0n;
const LANDLOCK_ACCESS_FS_WRITE_FILE   = 1n << 1n;
const LANDLOCK_ACCESS_FS_READ_FILE    = 1n << 2n;
const LANDLOCK_ACCESS_FS_READ_DIR     = 1n << 3n;
const LANDLOCK_ACCESS_FS_REMOVE_DIR   = 1n << 4n;
const LANDLOCK_ACCESS_FS_REMOVE_FILE  = 1n << 5n;
const LANDLOCK_ACCESS_FS_MAKE_CHAR    = 1n << 6n;
const LANDLOCK_ACCESS_FS_MAKE_DIR     = 1n << 7n;
const LANDLOCK_ACCESS_FS_MAKE_REG     = 1n << 8n;
const LANDLOCK_ACCESS_FS_MAKE_SOCK    = 1n << 9n;
const LANDLOCK_ACCESS_FS_MAKE_FIFO    = 1n << 10n;
const LANDLOCK_ACCESS_FS_MAKE_BLOCK   = 1n << 11n;
const LANDLOCK_ACCESS_FS_MAKE_SYM     = 1n << 12n;

// ABI 2 (kernel 5.19+)
const LANDLOCK_ACCESS_FS_REFER        = 1n << 13n;
// ABI 3 (kernel 6.2+)
const LANDLOCK_ACCESS_FS_TRUNCATE     = 1n << 14n;
// ABI 5 (kernel 6.10+)
const LANDLOCK_ACCESS_FS_IOCTL_DEV    = 1n << 15n;

// ABI 4 network access flags (kernel 6.7+)
const LANDLOCK_ACCESS_NET_BIND_TCP    = 1n << 0n;
const LANDLOCK_ACCESS_NET_CONNECT_TCP = 1n << 1n;

// prctl constants
const PR_SET_NO_NEW_PRIVS = 38;

// open() flag
const O_PATH = 0x200000;

// stat mode constants for fstat directory detection
const S_IFMT  = 0o170000;
const S_IFDIR = 0o040000;

// ─── Per-ABI capability sets ───

function fsAccessMask(abi: number): bigint {
    let mask =
        LANDLOCK_ACCESS_FS_EXECUTE |
        LANDLOCK_ACCESS_FS_WRITE_FILE |
        LANDLOCK_ACCESS_FS_READ_FILE |
        LANDLOCK_ACCESS_FS_READ_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE |
        LANDLOCK_ACCESS_FS_MAKE_CHAR |
        LANDLOCK_ACCESS_FS_MAKE_DIR |
        LANDLOCK_ACCESS_FS_MAKE_REG |
        LANDLOCK_ACCESS_FS_MAKE_SOCK |
        LANDLOCK_ACCESS_FS_MAKE_FIFO |
        LANDLOCK_ACCESS_FS_MAKE_BLOCK |
        LANDLOCK_ACCESS_FS_MAKE_SYM;
    if (abi >= 2) mask |= LANDLOCK_ACCESS_FS_REFER;
    if (abi >= 3) mask |= LANDLOCK_ACCESS_FS_TRUNCATE;
    if (abi >= 5) mask |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
    return mask;
}

function netAccessMask(abi: number): bigint {
    if (abi < 4) return 0n;
    return LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP;
}

// ─── Access flag composites ───

const READ_ACCESS =
    LANDLOCK_ACCESS_FS_READ_FILE |
    LANDLOCK_ACCESS_FS_READ_DIR;

function writeAccess(abi: number): bigint {
    let mask =
        LANDLOCK_ACCESS_FS_READ_FILE |
        LANDLOCK_ACCESS_FS_READ_DIR |
        LANDLOCK_ACCESS_FS_WRITE_FILE |
        LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE |
        LANDLOCK_ACCESS_FS_MAKE_CHAR |
        LANDLOCK_ACCESS_FS_MAKE_DIR |
        LANDLOCK_ACCESS_FS_MAKE_REG |
        LANDLOCK_ACCESS_FS_MAKE_SOCK |
        LANDLOCK_ACCESS_FS_MAKE_FIFO |
        LANDLOCK_ACCESS_FS_MAKE_BLOCK |
        LANDLOCK_ACCESS_FS_MAKE_SYM;
    if (abi >= 2) mask |= LANDLOCK_ACCESS_FS_REFER;
    if (abi >= 3) mask |= LANDLOCK_ACCESS_FS_TRUNCATE;
    return mask;
}

// ─── FFI library handle (lazy-loaded) ───

interface LibC {
    syscall(nr: bigint, ...args: bigint[]): bigint;
    prctl(option: number, arg2: bigint, arg3: bigint, arg4: bigint, arg5: bigint): number;
    open(path: Deno.PointerValue, flags: number): number;
    close(fd: number): number;
    fstat(fd: number, buf: Deno.PointerValue): number;
}

let _libc: LibC | null = null;

function getLibC(): LibC {
    if (_libc) return _libc;

    const lib = Deno.dlopen("libc.so.6", {
        syscall: {
            parameters: ["i64", "i64", "i64", "i64", "i64"] as const,
            result: "i64",
        },
        prctl: {
            parameters: ["i32", "u64", "u64", "u64", "u64"] as const,
            result: "i32",
        },
        fstat: {
            parameters: ["i32", "pointer"] as const,
            result: "i32",
        },
        open: {
            parameters: ["pointer", "i32"] as const,
            result: "i32",
        },
        close: {
            parameters: ["i32"] as const,
            result: "i32",
        },
    });

    _libc = {
        syscall: (nr: bigint, ...args: bigint[]) => {
            const a = args[0] ?? 0n;
            const b = args[1] ?? 0n;
            const c = args[2] ?? 0n;
            const d = args[3] ?? 0n;
            return lib.symbols.syscall(nr, a, b, c, d) as bigint;
        },
        prctl: (option, arg2, arg3, arg4, arg5) =>
            lib.symbols.prctl(option, arg2, arg3, arg4, arg5) as number,
        fstat: (fd, buf) =>
            lib.symbols.fstat(fd, buf as Deno.PointerValue) as number,
        open: (path, flags) =>
            lib.symbols.open(path as Deno.PointerValue, flags) as number,
        close: (fd) =>
            lib.symbols.close(fd) as number,
    };

    return _libc;
}

// ─── Struct builders ───

/**
 * struct landlock_ruleset_attr {
 *     __u64 handled_access_fs;   // 8 bytes
 *     __u64 handled_access_net;  // 8 bytes (ABI 4+, ignored on earlier)
 *     __u64 scoped;              // 8 bytes (ABI 5+, ignored on earlier)
 * };
 * Total: 24 bytes
 */
function buildRulesetAttr(fsAccess: bigint, netAccess: bigint): Uint8Array<ArrayBuffer> {
    const buf = new ArrayBuffer(24);
    const view = new DataView(buf);
    view.setBigUint64(0, fsAccess, true);
    view.setBigUint64(8, netAccess, true);
    view.setBigUint64(16, 0n, true);  // scoped
    return new Uint8Array(buf) as Uint8Array<ArrayBuffer>;
}

/**
 * struct landlock_path_beneath_attr {
 *     __u64 allowed_access;  // 8 bytes
 *     __s32 parent_fd;       // 4 bytes
 *     // 4 bytes padding
 * };
 * Total: 16 bytes
 */
function buildPathBeneathAttr(allowedAccess: bigint, parentFd: number): Uint8Array<ArrayBuffer> {
    const buf = new ArrayBuffer(16);
    const view = new DataView(buf);
    view.setBigUint64(0, allowedAccess, true);
    view.setInt32(8, parentFd, true);
    return new Uint8Array(buf) as Uint8Array<ArrayBuffer>;
}

/**
 * struct landlock_net_port_attr {
 *     __u64 allowed_access;  // 8 bytes
 *     __u64 port;            // 8 bytes
 * };
 * Total: 16 bytes
 */
function buildNetPortAttr(allowedAccess: bigint, port: number): Uint8Array<ArrayBuffer> {
    const buf = new ArrayBuffer(16);
    const view = new DataView(buf);
    view.setBigUint64(0, allowedAccess, true);
    view.setBigUint64(8, BigInt(port), true);
    return new Uint8Array(buf) as Uint8Array<ArrayBuffer>;
}

/**
 * Discovers the offset of st_mode within struct stat at runtime.
 * Opens "/" (guaranteed directory), fstats it, and scans for the S_IFDIR
 * bit pattern. This avoids hardcoding architecture-specific offsets
 * (aarch64 = 16, x86_64 = 24, etc.).
 */
let _stModeOffset: number | null = null;

function discoverStModeOffset(libc: LibC): number {
    if (_stModeOffset !== null) return _stModeOffset;

    const rootFd = openPath(libc, "/");
    try {
        const buf = new ArrayBuffer(256);
        const statBuf = new Uint8Array(buf) as Uint8Array<ArrayBuffer>;
        const ptr = Deno.UnsafePointer.of(statBuf);
        const result = libc.fstat(rootFd, ptr);
        if (result !== 0) {
            throw new Error("fstat('/') failed — cannot discover st_mode offset");
        }
        const view = new DataView(buf);
        // Scan 4-byte-aligned offsets for the S_IFDIR pattern.
        for (let offset = 0; offset < 128; offset += 4) {
            const val = view.getUint32(offset, true);
            if ((val & S_IFMT) === S_IFDIR) {
                _stModeOffset = offset;
                return offset;
            }
        }
        throw new Error("Could not locate st_mode in struct stat — no S_IFDIR found for '/'");
    } finally {
        libc.close(rootFd);
    }
}

/**
 * Checks whether an open O_PATH file descriptor refers to a directory
 * by calling fstat and inspecting st_mode at the runtime-discovered offset.
 */
function isDirectory(libc: LibC, fd: number): boolean {
    const buf = new ArrayBuffer(256);
    const statBuf = new Uint8Array(buf) as Uint8Array<ArrayBuffer>;
    const ptr = Deno.UnsafePointer.of(statBuf);
    const result = libc.fstat(fd, ptr);
    if (result !== 0) return false;
    const view = new DataView(buf);
    const mode = view.getUint32(discoverStModeOffset(libc), true);
    return (mode & S_IFMT) === S_IFDIR;
}

// ─── Public API ───

/**
 * Queries the kernel's Landlock ABI version.
 * Returns 0 if Landlock is not supported.
 */
export function queryLandlockABI(): number {
    try {
        const libc = getLibC();
        // landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)
        // LANDLOCK_CREATE_RULESET_VERSION = 1 << 0 = 1
        const result = libc.syscall(
            BigInt(SYS_landlock_create_ruleset),
            0n,  // attr = NULL
            0n,  // size = 0
            1n,  // flags = LANDLOCK_CREATE_RULESET_VERSION
        );
        if (result < 0n) return 0;
        return Number(result);
    } catch {
        return 0;
    }
}

/**
 * Opens a path with O_PATH for Landlock rule registration.
 * Returns the file descriptor or throws on failure.
 */
function openPath(libc: LibC, path: string): number {
    const encoded = new Uint8Array(new TextEncoder().encode(path + "\0").buffer) as Uint8Array<ArrayBuffer>;
    const ptr = Deno.UnsafePointer.of(encoded);
    const fd = libc.open(ptr, O_PATH);
    if (fd < 0) {
        throw new Error(`Failed to open path for Landlock rule: ${path} (errno likely ENOENT or EACCES)`);
    }
    return fd;
}

/** Directory-only access flags — invalid for non-directory inodes. */
const DIR_ONLY_ACCESS =
    LANDLOCK_ACCESS_FS_READ_DIR |
    LANDLOCK_ACCESS_FS_REMOVE_DIR |
    LANDLOCK_ACCESS_FS_MAKE_CHAR |
    LANDLOCK_ACCESS_FS_MAKE_DIR |
    LANDLOCK_ACCESS_FS_MAKE_REG |
    LANDLOCK_ACCESS_FS_MAKE_SOCK |
    LANDLOCK_ACCESS_FS_MAKE_FIFO |
    LANDLOCK_ACCESS_FS_MAKE_BLOCK |
    LANDLOCK_ACCESS_FS_MAKE_SYM;

/**
 * Adds a path rule to the Landlock ruleset.
 * Silently skips paths that don't exist on this system (e.g. /lib64 on some distros).
 * Uses fstat() to detect file vs directory and strips dir-only flags for non-directories.
 */
function addPathRule(
    libc: LibC,
    rulesetFd: number,
    access: bigint,
    path: string,
): void {
    let fd: number;
    try {
        fd = openPath(libc, path);
    } catch {
        // Path doesn't exist on this system — skip silently.
        return;
    }

    try {
        // Landlock rejects dir-only flags (READ_DIR, MAKE_*, REMOVE_DIR) for
        // non-directory inodes. Use fstat to detect the inode type upfront.
        const effectiveAccess = isDirectory(libc, fd)
            ? access
            : access & ~DIR_ONLY_ACCESS;

        if (effectiveAccess === 0n) return; // No applicable flags for this path.

        const attr = buildPathBeneathAttr(effectiveAccess, fd);
        const attrPtr = Deno.UnsafePointer.of(attr);
        const result = libc.syscall(
            BigInt(SYS_landlock_add_rule),
            BigInt(rulesetFd),
            BigInt(LANDLOCK_RULE_PATH_BENEATH),
            BigInt(Deno.UnsafePointer.value(attrPtr!)),
        );
        if (result < 0n) {
            throw new Error(`landlock_add_rule failed for ${path} (result=${result}, access=0x${effectiveAccess.toString(16)})`);
        }
    } finally {
        libc.close(fd);
    }
}

/**
 * Adds a network port rule to the Landlock ruleset (ABI 4+ only).
 */
function addNetPortRule(
    libc: LibC,
    rulesetFd: number,
    access: bigint,
    port: number,
): void {
    const attr = buildNetPortAttr(access, port);
    const attrPtr = Deno.UnsafePointer.of(attr);
    const result = libc.syscall(
        BigInt(SYS_landlock_add_rule),
        BigInt(rulesetFd),
        BigInt(LANDLOCK_RULE_NET_PORT),
        BigInt(Deno.UnsafePointer.value(attrPtr!)),
    );
    if (result < 0n) {
        throw new Error(`landlock_add_rule (NET_PORT) failed for port ${port}`);
    }
}

/**
 * Applies Landlock restrictions to the current process.
 * This is irreversible — once applied, the restrictions cannot be loosened.
 *
 * Call this after reading the sandbox payload but before loading any
 * untrusted guest code. The restrictions are inherited by all child
 * threads and processes.
 *
 * @throws If the kernel doesn't support Landlock (< 5.13) or if
 *         any syscall fails unexpectedly.
 */
export function applyLandlockJail(policy: LandlockPolicy): void {
    const abi = queryLandlockABI();
    if (abi === 0) {
        throw new Error(
            "[webrun] Fatal: Linux kernel does not support Landlock (requires 5.13+). " +
            "Cannot enforce OS-level sandbox."
        );
    }

    if (abi < 4) {
        console.error(
            `[webrun] Warning: Landlock ABI ${abi} — network/ioctl restrictions ` +
            `unavailable (kernel < 6.7). Network enforcement via runtime flags only.`
        );
    }

    const libc = getLibC();

    // 1. Create the ruleset with supported access types.
    const handledFs = fsAccessMask(abi);
    const handledNet = netAccessMask(abi);
    const rulesetAttr = buildRulesetAttr(handledFs, handledNet);
    const rulesetAttrPtr = Deno.UnsafePointer.of(rulesetAttr);

    const rulesetFd = Number(libc.syscall(
        BigInt(SYS_landlock_create_ruleset),
        BigInt(Deno.UnsafePointer.value(rulesetAttrPtr!)),
        BigInt(rulesetAttr.byteLength),
        0n,  // flags = 0
    ));

    if (rulesetFd < 0) {
        throw new Error(`[webrun] Fatal: landlock_create_ruleset failed (errno: ${-rulesetFd})`);
    }

    try {
        // 2. Add filesystem rules.
        const readAccess = READ_ACCESS;
        const fullWriteAccess = writeAccess(abi);
        const execAccess = LANDLOCK_ACCESS_FS_EXECUTE | READ_ACCESS;

        for (const path of policy.read_paths) {
            addPathRule(libc, rulesetFd, readAccess, path);
        }
        for (const path of policy.write_paths) {
            addPathRule(libc, rulesetFd, fullWriteAccess, path);
        }
        for (const path of policy.exec_paths) {
            addPathRule(libc, rulesetFd, execAccess, path);
        }

        // 3. Add network rules (ABI 4+ only).
        if (abi >= 4) {
            for (const port of policy.tcp_connect_ports) {
                addNetPortRule(libc, rulesetFd, LANDLOCK_ACCESS_NET_CONNECT_TCP, port);
            }
            for (const port of policy.tcp_bind_ports) {
                addNetPortRule(libc, rulesetFd, LANDLOCK_ACCESS_NET_BIND_TCP, port);
            }
        }

        // 4. Set PR_SET_NO_NEW_PRIVS (required before landlock_restrict_self).
        const prctlResult = libc.prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n);
        if (prctlResult !== 0) {
            throw new Error(`[webrun] Fatal: prctl(PR_SET_NO_NEW_PRIVS) failed (${prctlResult})`);
        }

        // 5. Enforce the ruleset. This is irreversible.
        const restrictResult = libc.syscall(
            BigInt(SYS_landlock_restrict_self),
            BigInt(rulesetFd),
            0n,  // flags = 0
        );
        if (restrictResult < 0n) {
            throw new Error(`[webrun] Fatal: landlock_restrict_self failed (errno: ${-Number(restrictResult)})`);
        }
    } finally {
        libc.close(rulesetFd);
    }
}
