/**
 * Fully resolved capability set — single source of truth for all jail backends.
 * Computed once from the merged config (user-declared) + host paths.
 * Each backend translates this structure into its native format.
 */
export interface CapabilityPath {
    path: string;
    optional?: boolean;
}

export interface ResolvedCapabilities {
    readPaths: CapabilityPath[];     // fully canonicalized
    writePaths: CapabilityPath[];
    execPaths: CapabilityPath[];
    env: string[] | "*";
    gpu: boolean;
    ffi: boolean;
    /** Infrastructure ports the sandbox must connect to (import proxy, relay, etc.). */
    localNetworkConnectPorts: number[];
    /** Infrastructure ports the sandbox must bind (relay listeners, etc.). */
    localNetworkBindPorts: number[];
    /** User-declared remote hosts the sandbox may connect to (from permissions.network). */
    remoteNetworkConnectHosts: string[];
    /** User-declared hosts the sandbox may bind to (from serve URLs). */
    remoteNetworkBindHosts: string[];
    /** Allowed remote import hosts */
    importHosts: string[];
    /** Whether this context may invoke ctx.run() to spawn child processes. */
    run: boolean;
    /** Binaries that Deno.Command may spawn (--allow-run). Only the runtime binary when run is true. */
    runPaths: string[];
    /** Unix socket paths the sandbox may connect to (spawner, etc.). */
    outboundSocketPaths: string[];
}

import type { WebrunPermissions } from "./types.ts";
import type { BundleInfo } from "./bundle.ts";
import { isBareCommand } from "./config.ts";

/**
 * System paths the sandbox must read for basic operation (libc, DNS, entropy, etc.).
 */
export const SYSTEM_READ_PATHS = {
    darwin: [
        { path: "/usr/lib", optional: true },
        { path: "/usr/local/lib", optional: true },
        { path: "/System/Library", optional: true },
        { path: "/dev/random", optional: true },
        { path: "/dev/urandom", optional: true },
        { path: "/dev/null", optional: true },
        { path: "/dev/tty", optional: true },
        { path: "/etc/resolv.conf", optional: true },
        { path: "/etc/hosts", optional: true },
        { path: "/etc/ssl", optional: true },
        { path: "/private/etc/resolv.conf", optional: true },
        { path: "/private/etc/hosts", optional: true },
        { path: "/private/etc/services", optional: true },
        { path: "/private/etc/ssl", optional: true },
        { path: "/private/var/run/mDNSResponder", optional: true },
        { path: "/nix/store", optional: true },
        { path: "/Library/Keychains", optional: true },
        { path: "/private/var/db/mds", optional: true },
        { path: "/private/var/db/systemstats", optional: true },
    ] as CapabilityPath[],
    linux: [
        { path: "/usr/lib", optional: true },
        { path: "/usr/lib64", optional: true },
        { path: "/lib", optional: true },
        { path: "/lib64", optional: true },
        { path: "/dev/urandom", optional: true },
        { path: "/dev/null", optional: true },
        { path: "/dev/tty", optional: true },
        { path: "/etc/resolv.conf", optional: true },
        { path: "/etc/hosts", optional: true },
        { path: "/etc/ld.so.cache", optional: true },
        { path: "/etc/ssl/certs", optional: true },
        { path: "/etc/ca-certificates", optional: true },
        { path: "/proc", optional: true },
        { path: "/nix/store", optional: true },
    ] as CapabilityPath[],
} as const;

/**
 * System paths the sandbox must execute for shared library loading.
 * On Linux, LANDLOCK_ACCESS_FS_EXECUTE governs dynamic linker access.
 */
export const SYSTEM_EXEC_PATHS = {
    darwin: [] as CapabilityPath[],
    linux: [
        { path: "/usr/lib", optional: true },
        { path: "/usr/lib64", optional: true },
        { path: "/lib", optional: true },
        { path: "/lib64", optional: true },
        { path: "/nix/store", optional: true },
    ] as CapabilityPath[],
} as const;

interface ResolveCapabilitiesInput {
    permissions: WebrunPermissions;
    bundle: BundleInfo;
    mode: "module" | "binary";
    os: "darwin" | "linux";
    /** Resolved serve endpoints — each contributes a port and a bind host. */
    serve: { port: number; host: string }[];
    dir?: string;
    tempDir: string;
    canonicalize: (p: string) => string;
    /** When the child config has no `permissions` field (P1), this is set to `dir`
     *  to enable permissive local reads. Undefined when restricted mode is active. */
    permissiveDir?: string;
    /** Optional function to resolve bare command names to absolute paths using the host's original PATH. */
    resolveBinary?: (cmd: string) => string | undefined;
}

function resolvePath(base: string, target: string): string {
    const p = new URL(target, "file://" + base + "/").pathname;
    return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * Resolves user-declared permissions + bundle context into a ResolvedCapabilities.
 */
export function resolveCapabilities(input: ResolveCapabilitiesInput): ResolvedCapabilities {
    const { permissions, bundle, mode, os, serve, dir, tempDir, canonicalize, permissiveDir } = input;
    const servePorts = serve.map(s => s.port);
    const serveHosts = serve.map(s => s.host);

    // Resolve storage paths against dir
    const readPaths: CapabilityPath[] = [];
    const writePaths: CapabilityPath[] = [];

    // Resolve storage paths against dir for additional read/write access.
    // Marked optional because user-declared paths may not yet exist on disk
    // (e.g. hostile configs, not-yet-created dirs). Landlock requires an inode
    // to open, so nonexistent paths are skipped. Deno's permission layer still
    // enforces access control for paths that don't exist.
    for (const [fsPath, storageAccess] of Object.entries(permissions.storage || {})) {
        const abs = canonicalize(resolvePath(dir ?? tempDir, fsPath));
        if (storageAccess.access === "write") {
            writePaths.push({ path: abs, optional: true });
            readPaths.push({ path: abs, optional: true });
        } else if (storageAccess.access === "read") {
            readPaths.push({ path: abs, optional: true });
        }
    }

    // Bundle paths need read access
    readPaths.push(...bundle.protectedPaths.map(p => ({ path: canonicalize(p), optional: false })));

    // Runtime binary dir needs read access
    readPaths.push({ path: canonicalize(bundle.binDir), optional: false });

    // Webrun's own source/bundle directories need read access
    for (const d of bundle.sourceDirs) {
        const canon = canonicalize(d);
        readPaths.push({ path: canon, optional: false });
        if (canon !== d) readPaths.push({ path: d, optional: false });
    }

    // System paths
    readPaths.push(...SYSTEM_READ_PATHS[os]);

    // Temp dir needs read + write
    const canonTemp = canonicalize(tempDir);
    readPaths.push({ path: canonTemp, optional: false });
    writePaths.push({ path: canonTemp, optional: false });

    // P1: permissive local reads when the child has no `permissions` field.
    if (permissiveDir) {
        const canonDir = canonicalize(permissiveDir);
        if (!readPaths.find(p => p.path === canonDir)) readPaths.push({ path: canonDir, optional: false });
    }

    // Binary exec paths from permissions.binaries
    const execPaths: CapabilityPath[] = [{ path: canonicalize(bundle.execPath), optional: false }, ...SYSTEM_EXEC_PATHS[os]];
    for (const prefix of permissions.binaries || []) {
        if (prefix.length > 0) {
            let binPath = prefix[0];
            if (input.resolveBinary && isBareCommand(binPath)) {
                const found = input.resolveBinary(binPath);
                if (found) binPath = found;
                else binPath = resolvePath(dir ?? tempDir, binPath);
            } else {
                binPath = resolvePath(dir ?? tempDir, binPath);
            }
            binPath = canonicalize(binPath);
            execPaths.push({ path: binPath, optional: true });
            readPaths.push({ path: binPath, optional: true });
        }
    }

    return {
        readPaths,
        writePaths,
        execPaths,
        env: permissions.env || [],
        gpu: !!permissions.gpu,
        ffi: false,
        localNetworkConnectPorts: servePorts,
        localNetworkBindPorts: servePorts,
        remoteNetworkConnectHosts: permissions.network || [],
        remoteNetworkBindHosts: [...serveHosts],
        importHosts: permissions.import || [],
        run: !!permissions.run || !!permissiveDir,
        runPaths: (!!permissions.run || !!permissiveDir) ? [canonicalize(bundle.execPath)] : [],
        outboundSocketPaths: [],
    };
}

/**
 * Augments guest capabilities with the minimum extras needed for jail setup
 * and sandbox process bootstrapping.
 *
 * The sandbox process needs:
 * - FFI access to call kernel sandbox APIs (seatbelt/landlock)
 * - Read access to the webrun source/bundle files to import sandbox code
 * - Read/write access to the Deno module cache
 * - Exec access to the runtime binary (to spawn Workers)
 *
 * This function adds these if the guest didn't already have them, and returns
 * the paired `drop` — the exact delta to revoke after the jail is applied.
 *
 * @returns `augmented` for Deno CLI spawn flags, `drop` for post-jail revocation.
 */
export function augmentForJail(
    caps: ResolvedCapabilities,
    bootstrap?: {
        /** Paths the sandbox needs to read (bundle source dir, deno cache, etc.) */
        readPaths?: string[];
        /** Paths the sandbox needs to write (deno cache, temp dirs, etc.) */
        writePaths?: string[];
        /** Paths the sandbox needs to exec (runtime binary). */
        execPaths?: string[];
        /** Unix socket paths the sandbox may connect to (spawner, etc.). */
        outboundSocketPaths?: string[];
        /** Keep FFI after jail (needed when spawner is active for pipe/sendmsg/connect). */
        keepFfi?: boolean;
    },
): { augmented: ResolvedCapabilities; drop: Partial<ResolvedCapabilities> } {
    const drop: Partial<ResolvedCapabilities> = {};
    const augmented = {
        ...caps,
        readPaths: [...caps.readPaths],
        writePaths: [...caps.writePaths],
        execPaths: [...caps.execPaths],
        outboundSocketPaths: [...caps.outboundSocketPaths, ...(bootstrap?.outboundSocketPaths || [])],
        remoteNetworkBindHosts: [...caps.remoteNetworkBindHosts],
    };

    // The sandbox's mux extension always binds to localhost on ephemeral ports.
    // Add to augmented but NOT to drop — the sandbox keeps this after revocation.
    if (!augmented.remoteNetworkBindHosts.includes("127.0.0.1")) {
        augmented.remoteNetworkBindHosts.push("127.0.0.1");
    }

    if (!caps.ffi) {
        augmented.ffi = true;
        if (!bootstrap?.keepFfi) {
            drop.ffi = false;
        }
    }

    if (!caps.run) {
        drop.run = false;
    }

    // Track bootstrap paths that were added beyond guest caps.
    const addedReadPaths: CapabilityPath[] = [];
    const addedWritePaths: CapabilityPath[] = [];
    const addedExecPaths: CapabilityPath[] = [];

    const dropReadPaths: CapabilityPath[] = [];
    const dropWritePaths: CapabilityPath[] = [];
    const dropExecPaths: CapabilityPath[] = [];

    for (const p of bootstrap?.readPaths || []) {
        if (!caps.readPaths.find(cp => cp.path === p)) {
            addedReadPaths.push({ path: p, optional: false });
            augmented.readPaths.push({ path: p, optional: false });
        }
    }
    for (const p of bootstrap?.writePaths || []) {
        if (!caps.writePaths.find(cp => cp.path === p)) {
            addedWritePaths.push({ path: p, optional: false });
            augmented.writePaths.push({ path: p, optional: false });
        }
    }
    for (const p of bootstrap?.execPaths || []) {
        if (!caps.execPaths.find(cp => cp.path === p)) {
            addedExecPaths.push({ path: p, optional: false });
            augmented.execPaths.push({ path: p, optional: false });
        }
    }

    if (addedReadPaths.length > 0) drop.readPaths = addedReadPaths;
    if (addedWritePaths.length > 0) drop.writePaths = addedWritePaths;
    if (addedExecPaths.length > 0) drop.execPaths = addedExecPaths;

    return { augmented, drop };
}

/**
 * Applies the drop delta to augmented capabilities, yielding guest-level caps.
 *
 * This is the inverse of `augmentForJail`: given the pre-revocation caps and
 * the drop delta, it returns the narrower capabilities the guest Worker runs with.
 */
export function applyDrop(
    caps: ResolvedCapabilities,
    drop: Partial<ResolvedCapabilities>,
): ResolvedCapabilities {
    return {
        ...caps,
        ffi: drop.ffi === false ? false : caps.ffi,
        run: drop.run === false ? false : caps.run,
        readPaths: drop.readPaths ? caps.readPaths.filter(p => !drop.readPaths!.some(dp => dp.path === p.path)) : caps.readPaths,
        writePaths: drop.writePaths ? caps.writePaths.filter(p => !drop.writePaths!.some(dp => dp.path === p.path)) : caps.writePaths,
        execPaths: drop.execPaths ? caps.execPaths.filter(p => !drop.execPaths!.some(dp => dp.path === p.path)) : caps.execPaths,
    };
}
