/**
 * Deno FFI adapter for Linux Landlock self-sandboxing.
 *
 * Applies Landlock restrictions to the current process via libc syscalls
 * through Deno.dlopen. The restrictions are irreversible and inherited
 * by child processes and threads.
 *
 * All Deno FFI types are injected via makeLandlock() — this module
 * contains no ambient Deno global access.
 *
 * Requires Linux kernel >= 5.13 with CONFIG_SECURITY_LANDLOCK=y.
 */

import type { LandlockPolicy } from "../../../core/jail/landlock/mod.ts";

// ── Structural dependency types ─────────────────────────────────────────────

/** Opaque pointer value used by FFI — structurally bigint | null. */
type PointerValue = bigint | null;

/** The subset of UnsafePointer this adapter actually calls. */
interface UnsafePointerAPI {
    of(buf: Uint8Array<ArrayBuffer>): PointerValue;
    value(ptr: NonNullable<PointerValue>): bigint;
}

/** Spec for a single foreign function symbol. */
interface ForeignFunctionSpec {
    parameters: readonly string[];
    result: string;
}

/** The Deno APIs that landlock actually needs. */
export interface LandlockDeps {
    dlopen(
        path: string,
        symbols: Record<string, ForeignFunctionSpec>,
    ): { symbols: Record<string, (...args: any[]) => any> };
    UnsafePointer: UnsafePointerAPI;
    /** Used to detect file vs directory for path rules. */
    statSync(path: string): { isDirectory: boolean };
}

// ── Syscall numbers (stable across x86_64 and aarch64) ───
const SYS_landlock_create_ruleset = 444;
const SYS_landlock_add_rule = 445;
const SYS_landlock_restrict_self = 446;

// ── Landlock constants ───

// Rule types
const LANDLOCK_RULE_PATH_BENEATH = 1;
const LANDLOCK_RULE_NET_PORT = 2;

// Landlock ABI 1 filesystem access flags (kernel 5.13+)
const LANDLOCK_ACCESS_FS_EXECUTE = 1n << 0n;
const LANDLOCK_ACCESS_FS_WRITE_FILE = 1n << 1n;
const LANDLOCK_ACCESS_FS_READ_FILE = 1n << 2n;
const LANDLOCK_ACCESS_FS_READ_DIR = 1n << 3n;
const LANDLOCK_ACCESS_FS_REMOVE_DIR = 1n << 4n;
const LANDLOCK_ACCESS_FS_REMOVE_FILE = 1n << 5n;
const LANDLOCK_ACCESS_FS_MAKE_CHAR = 1n << 6n;
const LANDLOCK_ACCESS_FS_MAKE_DIR = 1n << 7n;
const LANDLOCK_ACCESS_FS_MAKE_REG = 1n << 8n;
const LANDLOCK_ACCESS_FS_MAKE_SOCK = 1n << 9n;
const LANDLOCK_ACCESS_FS_MAKE_FIFO = 1n << 10n;
const LANDLOCK_ACCESS_FS_MAKE_BLOCK = 1n << 11n;
const LANDLOCK_ACCESS_FS_MAKE_SYM = 1n << 12n;

// ABI 2 (kernel 5.19+)
const LANDLOCK_ACCESS_FS_REFER = 1n << 13n;
// ABI 3 (kernel 6.2+)
const LANDLOCK_ACCESS_FS_TRUNCATE = 1n << 14n;
// ABI 5 (kernel 6.10+)
const LANDLOCK_ACCESS_FS_IOCTL_DEV = 1n << 15n;

// ABI 4 network access flags (kernel 6.7+)
const LANDLOCK_ACCESS_NET_BIND_TCP = 1n << 0n;
const LANDLOCK_ACCESS_NET_CONNECT_TCP = 1n << 1n;

// prctl constants
const PR_SET_NO_NEW_PRIVS = 38;

// open() flag
const O_PATH = 0x200000;

// ── Per-ABI capability sets ───

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

// ── Access flag composites ───

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

// ── Struct builders ───

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

// ── Internal libc wrapper type ──────────────────────────────────────────────

interface LibC {
    syscall(nr: bigint, ...args: bigint[]): bigint;
    prctl(option: number, arg2: bigint, arg3: bigint, arg4: bigint, arg5: bigint): number;
    open(path: PointerValue, flags: number): number;
    close(fd: number): number;
}

// ── Factory ─────────────────────────────────────────────────────────────────

export interface Landlock {
    /** Queries the kernel's Landlock ABI version. Returns 0 if unsupported. */
    queryLandlockABI(): number;

    /**
     * Applies Landlock restrictions to the current process.
     * This is irreversible — once applied, the restrictions cannot be loosened.
     */
    applyLandlock(policy: LandlockPolicy): void;
}

export function makeLandlock(deps: LandlockDeps): Landlock {
    let _libc: LibC | null = null;

    function getLibC(): LibC {
        if (_libc) return _libc;

        const lib = deps.dlopen("libc.so.6", {
            syscall: {
                parameters: ["i64", "i64", "i64", "i64", "i64"] as const,
                result: "i64",
            },
            prctl: {
                parameters: ["i32", "u64", "u64", "u64", "u64"] as const,
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
            open: (path, flags) =>
                lib.symbols.open(path as PointerValue, flags) as number,
            close: (fd) =>
                lib.symbols.close(fd) as number,
        };

        return _libc;
    }

    function openPath(libc: LibC, path: string): number {
        const encoded = new Uint8Array(new TextEncoder().encode(path + "\0").buffer) as Uint8Array<ArrayBuffer>;
        const ptr = deps.UnsafePointer.of(encoded);
        const fd = libc.open(ptr, O_PATH);
        if (fd < 0) {
            throw new Error(`Failed to open path for Landlock rule: ${path} (errno likely ENOENT or EACCES)`);
        }
        return fd;
    }

    function addPathRule(
        libc: LibC,
        rulesetFd: number,
        access: bigint,
        capPath: { path: string; optional?: boolean },
    ): void {
        let fd: number;
        try {
            fd = openPath(libc, capPath.path);
        } catch (e) {
            if (capPath.optional) return;
            throw e;
        }

        try {
            const isDir = deps.statSync(capPath.path).isDirectory;

            const effectiveAccess = isDir
                ? access
                : access & ~DIR_ONLY_ACCESS;

            if (effectiveAccess === 0n) return;

            const attr = buildPathBeneathAttr(effectiveAccess, fd);
            const attrPtr = deps.UnsafePointer.of(attr);
            const result = libc.syscall(
                BigInt(SYS_landlock_add_rule),
                BigInt(rulesetFd),
                BigInt(LANDLOCK_RULE_PATH_BENEATH),
                BigInt(deps.UnsafePointer.value(attrPtr!)),
            );
            if (result < 0n) {
                throw new Error(`landlock_add_rule failed for ${capPath.path} (result=${result}, access=0x${effectiveAccess.toString(16)})`);
            }
        } finally {
            libc.close(fd);
        }
    }

    function addNetPortRule(
        libc: LibC,
        rulesetFd: number,
        access: bigint,
        port: number,
    ): void {
        const attr = buildNetPortAttr(access, port);
        const attrPtr = deps.UnsafePointer.of(attr);
        const result = libc.syscall(
            BigInt(SYS_landlock_add_rule),
            BigInt(rulesetFd),
            BigInt(LANDLOCK_RULE_NET_PORT),
            BigInt(deps.UnsafePointer.value(attrPtr!)),
        );
        if (result < 0n) {
            throw new Error(`landlock_add_rule (NET_PORT) failed for port ${port}`);
        }
    }

    function queryLandlockABI(): number {
        try {
            const libc = getLibC();
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

    function applyLandlock(policy: LandlockPolicy): void {
        const abi = queryLandlockABI();
        if (abi === 0) {
            throw new Error(
                "[webrun] Fatal: Linux kernel does not support Landlock (requires 5.13+). " +
                "Cannot enforce OS-level sandbox."
            );
        }

        if (abi < 4) {
            throw new Error(
                `[webrun] Fatal: Landlock ABI ${abi} — network/ioctl restrictions ` +
                `unavailable (kernel < 6.7). Cannot strictly enforce OS-level network sandbox.`
            );
        }

        const libc = getLibC();

        // 1. Create the ruleset with supported access types.
        const handledFs = fsAccessMask(abi);
        let handledNet = netAccessMask(abi);
        if (policy.tcp_bind_ports === null && abi >= 4) {
            handledNet = handledNet & ~LANDLOCK_ACCESS_NET_BIND_TCP;
        }
        if (policy.tcp_connect_ports === null && abi >= 4) {
            handledNet = handledNet & ~LANDLOCK_ACCESS_NET_CONNECT_TCP;
        }
        const rulesetAttr = buildRulesetAttr(handledFs, handledNet);
        const rulesetAttrPtr = deps.UnsafePointer.of(rulesetAttr);

        const rulesetFd = Number(libc.syscall(
            BigInt(SYS_landlock_create_ruleset),
            BigInt(deps.UnsafePointer.value(rulesetAttrPtr!)),
            BigInt(rulesetAttr.byteLength),
            0n,
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
                if (policy.tcp_connect_ports !== null) {
                    for (const port of policy.tcp_connect_ports) {
                        addNetPortRule(libc, rulesetFd, LANDLOCK_ACCESS_NET_CONNECT_TCP, port);
                    }
                }
                if (policy.tcp_bind_ports !== null) {
                    for (const port of policy.tcp_bind_ports) {
                        addNetPortRule(libc, rulesetFd, LANDLOCK_ACCESS_NET_BIND_TCP, port);
                    }
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
                0n,
            );
            if (restrictResult < 0n) {
                throw new Error(`[webrun] Fatal: landlock_restrict_self failed (errno: ${-Number(restrictResult)})`);
            }
        } finally {
            libc.close(rulesetFd);
        }
    }

    return { queryLandlockABI, applyLandlock };
}
