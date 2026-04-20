import { resolve, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { tryRealpathSync } from "./sys.ts";
import type { EnclavePolicy } from "./policy.ts";
import type { JailRuntime, LandlockPolicy, CommandInvocation } from "./types.ts";

// =========================================================
// JAIL: Process image construction and OS-level enforcement
// =========================================================


/** Result of building a platform-specific jail configuration. */
export interface JailConfig {
    /** Binary to exec (e.g. /usr/bin/sandbox-exec or deno itself). */
    baseCmd: string;
    /** Arguments to the jail binary. */
    execArgs: string[];
    /** Extra env vars to merge into the child process env. */
    extraEnv: Record<string, string>;
    /** Landlock policy for Linux self-sandboxing (serialized into payload). */
    landlockPolicy?: LandlockPolicy;
}

/** All filesystem paths needed by sandbox configuration and jail enforcement. */
export interface SandboxPaths {
    projectRoot: string;
    cwd: string;
    localCacheDir: string;
    isolatedTmp: string;
    runnerTmp: string;
    opfsTmp: string;
    bindingSdksTmp: string;
    webrunEntryPath: string;
}

/**
 * Shared system dependency paths — single source of truth.
 * Each jail backend uses these to grant read access to host system resources
 * needed by the runtime (libc, DNS, entropy, etc.).
 */
export const SYSTEM_READ_PATHS = {
    darwin: [
        "/usr/lib", "/usr/local/lib", "/System/Library",
        "/dev/random", "/dev/urandom", "/dev/null", "/dev/tty",
        "/etc/resolv.conf", "/etc/hosts",
        "/private/etc/resolv.conf", "/private/etc/hosts",
        "/private/etc/services", "/private/var/run/mDNSResponder",
    ],
    linux: [
        "/usr/lib", "/usr/lib64", "/lib", "/lib64",
        "/dev/urandom", "/dev/null", "/dev/tty",
        "/etc/resolv.conf", "/etc/hosts",
        "/etc/ld.so.cache", "/etc/ssl/certs", "/etc/ca-certificates",
        "/proc/self",
    ],
} as const;

/**
 * Top-level dispatch — selects the jail backend for the current OS.
 *
 * On "darwin": computes a macOS seatbelt profile and wraps via /usr/bin/sandbox-exec.
 * On "linux": builds a LandlockPolicy for kernel self-sandboxing (applied by the guest).
 * On "none" (self-test) or unknown OS: passthrough (deno direct).
 */
export function buildJailConfig(
    sys: JailRuntime,
    os: string,
    policy: EnclavePolicy,
    innerRuntimeArgs: string[],
    paths: SandboxPaths,
    ephemeralPorts: number[],
    allowGpu: boolean,
    hasNetwork: boolean = false,
    /**
     * @deprecated Legacy bridge: absolute path to the webrun binary.
     * When set, grants process-fork + process-exec in the seatbelt
     * and --allow-run in Deno so testsys.Command can spawn children.
     * Remove alongside testCapabilities in Phase E.
     */
    legacyRunBin?: string,
): JailConfig {
    if (os === "darwin") {
        const { readEnclaves, writeEnclaves } = generateSeatbeltEnclaveStrings(
            sys, policy, paths.runnerTmp, paths.opfsTmp, paths.bindingSdksTmp, paths.webrunEntryPath
        );
        const seatbeltProfile = generateSeatbeltProfile(
            paths.cwd, readEnclaves, writeEnclaves, ephemeralPorts, allowGpu, hasNetwork, legacyRunBin
        );
        return buildDarwinJailConfig(sys, seatbeltProfile, paths, innerRuntimeArgs, legacyRunBin);
    }

    if (os === "linux") {
        const landlockPolicy = buildLandlockPolicy(sys, policy, paths, ephemeralPorts, allowGpu);
        return buildLinuxJailConfig(sys, innerRuntimeArgs, landlockPolicy);
    }

    // Passthrough for self-test ("none") and unknown OS.
    return {
        baseCmd: sys.execPath(),
        execArgs: innerRuntimeArgs,
        extraEnv: {},
    };
}

/** Constructs the darwin seatbelt jail config. */
function buildDarwinJailConfig(
    sys: JailRuntime,
    seatbeltProfile: string,
    paths: SandboxPaths,
    innerRuntimeArgs: string[],
    /** @deprecated Legacy bridge: when set, WEBRUN_DENO_DIR is exposed to the seatbelt so the bash wrapper can find Deno. */
    legacyRunBin?: string,
): JailConfig {
    // The Deno binary lives at execPath(). Its parent directory is the
    // version-specific dir where the bash wrapper expects to find `deno`.
    const denoBin = sys.execPath();
    const denoDir = dirname(denoBin);
    return {
        baseCmd: "/usr/bin/sandbox-exec",
        execArgs: [
            "-p", seatbeltProfile,
            "-D", `WEBRUN_SANDBOX_CACHE=${paths.localCacheDir}`,
            "-D", `WEBRUN_ISOLATED_TMP=${paths.isolatedTmp}`,
            "-D", `WEBRUN_DENO_JSON=${resolve(paths.projectRoot, "deno.json")}`,
            "-D", `WEBRUN_DENO_JSONC=${resolve(paths.projectRoot, "deno.jsonc")}`,
            "-D", `WEBRUN_DENO_LOCK=${resolve(paths.projectRoot, "deno.lock")}`,
            "-D", `WEBRUN_SCRIPT_PATH=${paths.webrunEntryPath}`,
            "-D", `WEBRUN_EXEC_DIR=${dirname(denoBin)}`,
            "-D", `WEBRUN_EXEC_PATH=${denoBin}`,
            ...(legacyRunBin ? ["-D", `WEBRUN_DENO_DIR=${denoDir}`] : []),
            denoBin,
            ...innerRuntimeArgs
        ],
        extraEnv: legacyRunBin ? { WEBRUN_DENO_DIR: denoDir } : {},
    };
}

/**
 * Constructs the Linux jail config.
 * The Deno process is spawned directly (no wrapper binary). The LandlockPolicy
 * is serialized into the sandbox payload and the guest applies it to itself
 * via FFI before loading any untrusted code.
 */
function buildLinuxJailConfig(
    sys: JailRuntime,
    innerRuntimeArgs: string[],
    landlockPolicy: LandlockPolicy,
): JailConfig {
    return {
        baseCmd: sys.execPath(),
        execArgs: innerRuntimeArgs,
        extraEnv: {},
        landlockPolicy,
    };
}

/**
 * Translates EnclavePolicy + SandboxPaths into a LandlockPolicy.
 * All paths are canonicalized via tryRealpathSync since Landlock
 * operates on inodes, not path strings.
 */
export function buildLandlockPolicy(
    sys: JailRuntime,
    policy: EnclavePolicy,
    paths: SandboxPaths,
    ephemeralPorts: number[],
    allowGpu: boolean,
): LandlockPolicy {
    const canon = (p: string) => tryRealpathSync(sys, p) || p;

    const readPaths = [
        ...SYSTEM_READ_PATHS.linux,
        canon(dirname(sys.execPath())),  // runtime binary dir
        canon(paths.webrunEntryPath),    // webrun source/bundle
        ...policy.allowedReadPaths.map(canon),
        canon(paths.runnerTmp),
        canon(paths.bindingSdksTmp),
        canon(paths.localCacheDir),
    ];

    // Only grant read access to the surrounding source directory if running
    // from the raw, unbundled source code.
    if (paths.webrunEntryPath.endsWith(".ts")) {
        const srcDir = canon(dirname(paths.webrunEntryPath));
        readPaths.push(srcDir);
    }

    const writePaths = [
        canon(paths.isolatedTmp),
        canon(paths.runnerTmp),
        canon(paths.opfsTmp),
        canon(paths.localCacheDir),
        ...policy.allowedWritePaths.map(canon),
    ];

    const execPaths = [canon(sys.execPath())];

    return {
        read_paths: readPaths,
        write_paths: writePaths,
        exec_paths: execPaths,
        tcp_connect_ports: [80, 443, ...ephemeralPorts],
        tcp_bind_ports: ephemeralPorts,
        gpu: allowGpu,
    };
}


/** Declarative representation of Deno permission flags. Single source of truth. */
export interface DenoPermissionSet {
    read: string[] | "*";
    write: string[] | "*";
    net: string[];
    denyNet: boolean;
    env: string[] | "*";
    run: string[] | "*";
    ffi: boolean;
    sys: string[];
    import: boolean;
}

/** Converts a DenoPermissionSet into Deno CLI --allow-* / --deny-* flags. */
export function serializePermissions(p: DenoPermissionSet): string[] {
    const flags: string[] = [];

    if (p.read === "*") flags.push("--allow-read");
    else if (p.read.length > 0) flags.push(`--allow-read=${p.read.join(",")}`);

    if (p.write === "*") flags.push("--allow-write");
    else if (p.write.length > 0) flags.push(`--allow-write=${p.write.join(",")}`);

    // Network flags are pre-built by buildNetworkFlags — pass through directly.
    flags.push(...p.net);
    if (p.denyNet && !p.net.some(f => f.startsWith("--allow-net"))) {
        flags.push("--deny-net");
    }

    if (p.env === "*") flags.push("--allow-env");
    else if (p.env.length > 0) flags.push(`--allow-env=${p.env.join(",")}`);

    if (p.run === "*") flags.push("--allow-run");
    else if (p.run.length > 0) flags.push(`--allow-run=${p.run.join(",")}`);

    if (p.ffi) flags.push("--allow-ffi");
    if (p.sys.length > 0) flags.push(`--allow-sys=${p.sys.join(",")}`);
    if (p.import) flags.push("--allow-import");

    return flags;
}

/**
 * Builds a DenoPermissionSet from policy and sandbox paths.
 * Replaces the former generateStorageFlags + isSelfTest permission branch.
 * All permissions are derived from the EnclavePolicy (which comes from webrun.json).
 */
export function buildPermissionSet(
    sys: JailRuntime, policy: EnclavePolicy, paths: SandboxPaths,
    os: string, networkFlags: string[], envPermissions: string[],
): DenoPermissionSet {
    const isLinux = os === "linux";

    // Read paths: sandbox infra + policy-declared paths.
    const unresolvedDir = dirname(paths.webrunEntryPath);
    const selfPath = tryRealpathSync(sys, paths.webrunEntryPath) || paths.webrunEntryPath;
    const readPaths = [
        paths.isolatedTmp, ...policy.allowedReadPaths,
        paths.runnerTmp, paths.opfsTmp,
        selfPath, paths.webrunEntryPath, paths.bindingSdksTmp,
    ];

    // Only grant read access to the surrounding source directory if running
    // from the raw, unbundled source code (since it needs to dynamically import sibling .ts files).
    if (paths.webrunEntryPath.endsWith(".ts")) {
        const selfDir = tryRealpathSync(sys, unresolvedDir) || unresolvedDir;
        readPaths.push(selfDir, unresolvedDir);
    }

    // On Linux, Landlock setup needs O_PATH access to system paths before
    // it applies the irreversible restrictions.
    if (isLinux) {
        readPaths.push(...SYSTEM_READ_PATHS.linux, dirname(sys.execPath()));
    }

    // Write paths: sandbox infra + policy-declared paths.
    const writePaths = [
        paths.isolatedTmp, ...policy.allowedWritePaths,
        paths.opfsTmp, paths.runnerTmp,
    ];

    // Env: always expose TMP_DIR (infrastructure). Additional vars from policy.
    let env: string[] | "*";
    if (envPermissions.length === 1 && envPermissions[0] === "*") {
        env = "*";
    } else {
        env = ["TMP_DIR", ...envPermissions.filter(e => e !== "TMP_DIR")];
    }

    // Parse network flags to determine denyNet state.
    const hasDenyNet = networkFlags.includes("--deny-net");
    const netFlags = networkFlags.filter(f => f !== "--deny-net");

    return {
        read: readPaths,
        write: writePaths,
        net: netFlags,
        denyNet: hasDenyNet,
        env,
        run: [],  // Populated by caller when legacyRunBin is set.
        ffi: isLinux,
        sys: ["networkInterfaces"],
        import: false,
    };
}

/**
 * Safely constructs macOS Sandbox (Seatbelt) Enclave subpaths mapping readable and writable
 * strict execution perimeters, translating EnclavePolicy definitions into Seatbelt expressions.
 */
export function generateSeatbeltEnclaveStrings(sys: JailRuntime, policy: EnclavePolicy, runnerTmp: string, opfsTmp: string, bindingSdksTmp: string, webrunEntryPath: string): { readEnclaves: string, writeEnclaves: string } {
    let readEnclaves = "";
    let writeEnclaves = "";

    const selfPath = tryRealpathSync(sys, webrunEntryPath) || webrunEntryPath;
    readEnclaves += `\n    (subpath "${selfPath}")`;

    // Only grant read access to the surrounding source directory if running
    // from the raw, unbundled source code (since it needs to dynamically import sibling .ts files).
    // Bundled executables are self-contained and do not need read access to their directory.
    if (webrunEntryPath.endsWith(".ts")) {
        const dirPath = dirname(selfPath);
        readEnclaves += `\n    (subpath "${dirPath}")`;
    }

    for (const p of policy.allowedReadPaths) {
        readEnclaves += `\n    (subpath "${p}")`;
    }
    readEnclaves += `\n    (subpath "${runnerTmp}")`;
    readEnclaves += `\n    (subpath "${bindingSdksTmp}")`;

    for (const p of policy.allowedWritePaths) {
        writeEnclaves += `\n    (subpath "${p}")`;
    }
    writeEnclaves += `\n    (subpath "${opfsTmp}")`;
    writeEnclaves += `\n    (subpath "${runnerTmp}")`;

    return { readEnclaves, writeEnclaves };
}

/**
 * Generates the raw macOS Sandbox (Seatbelt) Policy Scheme (.sb) layout payload
 * structurally locking down OS network vectors and read/writes tightly to isolation thresholds natively.
 */
export function generateSeatbeltProfile(
    cwd: string,
    readEnclaves: string,
    writeEnclaves: string,
    ephemeralPorts: number[],
    allowGpu: boolean,
    hasNetwork: boolean = false,
    /** @deprecated Legacy bridge: when set, allows process-fork + process-exec for this binary. */
    legacyRunBin?: string,
): string {
    let extraNetworkOutbound = "";
    let extraNetworkInbound = "";
    for (const port of ephemeralPorts) {
        extraNetworkOutbound += `\n    (remote tcp "localhost:${port}")`;
        extraNetworkInbound += `\n    (local tcp "*:${port}")\n    (local tcp "localhost:${port}")`;
    }
    // OS-level network gating. The seatbelt can only distinguish "no network"
    // from "any network" — it accepts only * or localhost as host values, and
    // cannot filter by port range or specific host. Per-host filtering is
    // handled by Deno's --allow-net/--deny-net flags. The seatbelt provides
    // defense-in-depth: if permissions.network is empty, the OS blocks all
    // outbound TCP/UDP regardless of Deno's state.
    if (hasNetwork) {
        extraNetworkOutbound += `\n    (remote tcp "*:*")\n    (remote udp "*:*")`;
        extraNetworkInbound += `\n    (local tcp "*:*")\n    (local udp "*:*")`;
    }

    let inboundBlock = "";
    if (extraNetworkInbound) {
        inboundBlock = `\n(allow network-inbound network-bind${extraNetworkInbound}\n)`;
    }

    return `(version 1)
(deny default)
(import "bsd.sb")
(allow file-read-metadata)
(allow signal)
(allow system-fsctl)
(deny process-exec)
${legacyRunBin ? `; @deprecated Legacy bridge: allow process-fork for testsys.Command child spawning.
(allow process-fork)` : `(deny process-fork)`}
${allowGpu ? `
(allow iokit-open)
(allow file-issue-extension)
(allow user-preference-read)` : ""}

(allow file-read* (literal "${cwd}"))

(allow process-exec
    (literal (param "WEBRUN_EXEC_PATH"))${legacyRunBin ? `
    ; @deprecated Legacy bridge: allow spawning webrun binary, bash, and POSIX utilities for testsys.Command.
    (literal "${legacyRunBin}")
    (subpath "/bin")
    (subpath "/usr/bin")` : ``}
)
${legacyRunBin ? `
; @deprecated Legacy bridge: allow reading the Deno cache so the bash wrapper can locate the Deno binary.
(allow file-read*
    (subpath (param "WEBRUN_DENO_DIR"))
)
` : ``}

(allow file-read*
    (subpath "/usr/lib")
    (subpath "/usr/local/lib")
    (subpath "/System/Library")
    (subpath "/opt/homebrew")
    (literal "/dev/random")
    (literal "/dev/urandom")
    (literal "/dev/null")
    (literal "/dev/tty")
    (literal "/etc/resolv.conf") 
    (literal "/etc/hosts")       
    (literal "/private/etc/resolv.conf") 
    (literal "/private/etc/hosts")       
    (literal "/private/etc/services")       
    (literal "/private/var/run/mDNSResponder")
)

; Allow terminal mode control (tcsetattr) for ctx.tty.setRawMode().
(allow file-ioctl
    (literal "/dev/tty")
    (regex #"^/dev/ttys[0-9]+$")
)

(allow file-read* file-map-executable
    (subpath (param "WEBRUN_EXEC_DIR"))
)

(allow system-socket)
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
${inboundBlock}
(allow network-outbound
    (remote udp "*:53")
    (literal "/private/var/run/mDNSResponder")${extraNetworkOutbound}
)
(allow file-read* file-write*
    (subpath (param "WEBRUN_SANDBOX_CACHE"))
    (subpath (param "WEBRUN_ISOLATED_TMP"))${allowGpu ? `\n    (regex #"^/private/var/folders/.*$")` : ""}${writeEnclaves}
)

(allow file-read*
    (literal (param "WEBRUN_DENO_JSON"))
    (literal (param "WEBRUN_DENO_JSONC"))
    (literal (param "WEBRUN_DENO_LOCK"))
    (literal (param "WEBRUN_SCRIPT_PATH"))${legacyRunBin ? `\n    ; @deprecated Legacy bridge: read access for webrun binary and POSIX utilities.\n    (literal "${legacyRunBin}")\n    (subpath "/bin")\n    (subpath "/usr/bin")` : ``}${readEnclaves}
)

(deny file-read* file-write*
    (regex #"^.*/\\\\.env.*$")
)
`;
}


/**
 * Maps invocation actions to Deno CLI subcommands.
 * Pure function — no I/O or side effects.
 */
export function buildSubcommand(action: string): string {
    if (action === "eval" || action === "serve" || action === "test") return "run";
    if (action === "check-only") return "check";
    return action;
}

/**
 * Builds the final network permission flags from the invocation's raw network
 * flags, serve interfaces, and the mux proxy port.
 *
 * Pure function — merges allow-list entries from serve interfaces and the
 * mux proxy into the network flags produced by config.ts.
 *
 * RFC 1918 note: An explicit --deny-net for private IP ranges (10.0.0.0/8,
 * 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16) is NOT required. When Deno
 * runs with --allow-net=<specific hosts>, all addresses not explicitly listed
 * are denied by the permission layer. Verified against Deno 2.7.
 */
export function buildNetworkFlags(
    rawNetworkFlags: string[],
    serveInterfaces: { host: string; port: number }[] | undefined,
    ephemeralPorts: number[],
): string[] {
    // Collect hosts that need explicit allow (serve interfaces + mux/binding ports).
    const allowList: string[] = [];
    if (serveInterfaces) {
        for (const iface of serveInterfaces) {
            allowList.push(`${iface.host}:${iface.port}`);
        }
    }
    for (const port of ephemeralPorts) {
        allowList.push(`127.0.0.1:${port}`);
    }

    if (allowList.length === 0) return [...rawNetworkFlags];

    // When we have specific ports to allow:
    // - bare --allow-net stays as-is (unrestricted)
    // - bare --deny-net converts to targeted loopback allow
    // - --allow-net=host merges with the new ports
    const result: string[] = [];
    let existingAllowNet: string | null = null;
    let hadBareDeny = false;

    for (const f of rawNetworkFlags) {
        if (f === "--deny-net") {
            hadBareDeny = true;
            continue;
        }
        if (f === "--allow-net") {
            existingAllowNet = "--allow-net";
            continue;
        }
        if (f.startsWith("--allow-net=")) {
            existingAllowNet = f;
            continue;
        }
        result.push(f);
    }

    // Bare --allow-net means unrestricted — keep it.
    if (existingAllowNet === "--allow-net") {
        result.push("--allow-net");
        return result;
    }

    // Merge all allow-list entries.
    const hosts = allowList.join(",");
    if (existingAllowNet) {
        result.push(`${existingAllowNet},${hosts}`);
    } else if (hadBareDeny) {
        // Had --deny-net but need specific ports open
        result.push(`--allow-net=${hosts}`);
    } else {
        result.push(`--allow-net=${hosts}`);
    }

    return result;
}

/** Input configuration for buildRuntimeArgs. */
export interface RuntimeArgsInput {
    sys: JailRuntime;
    invocation: CommandInvocation;
    maxV8MemMB?: number;
    importMapPath: string;
    ephemeralPorts: number[];
    policy: EnclavePolicy;
    paths: SandboxPaths;
    payloadPath: string;
    os: string;
    envPermissions: string[];
    /**
     * @deprecated Legacy bridge: when set, grants --allow-run for this binary.
     * Remove alongside testCapabilities in Phase E.
     */
    legacyRunBin?: string;
}

/**
 * Builds the complete Deno CLI argument vector for a sandbox invocation.
 * Pure function — no I/O, no side effects, no isSelfTest branching.
 * Permissions are derived entirely from the EnclavePolicy (which comes from webrun.json).
 */
export function buildRuntimeArgs(input: RuntimeArgsInput): string[] {
    const { sys, invocation, maxV8MemMB, importMapPath, ephemeralPorts,
            policy, paths, payloadPath, os, envPermissions } = input;
    const isCheckOnly = invocation.action === "check-only";
    const isLinux = os === "linux";

    // 1. Subcommand
    const subcommand = buildSubcommand(invocation.action);

    // 2. Network flags (skipped for check-only — no runtime execution)
    const networkFlags = isCheckOnly
        ? []
        : buildNetworkFlags(invocation.networkFlags, invocation.serveInterfaces, ephemeralPorts);

    const args = [subcommand];

    // 3. Runtime capability flags
    if (!isCheckOnly) {
        args.push(
            "--unstable-worker-options",
            "--unstable-net",
            `--import-map=${importMapPath}`
        );
        if (maxV8MemMB !== undefined) {
            args.push(`--v8-flags=--max-old-space-size=${maxV8MemMB}`);
        }
        if (isLinux) args.push("--unstable-ffi");
        // Explicitly control Deno's config resolution. Without this, Deno walks
        // up from CWD and may find the wrong config (user's project in bundled
        // mode) or no config at all (temp dir CWD in unbundled mode).
        if (paths.webrunEntryPath.endsWith(".ts")) {
            args.push(`--config=${resolve(dirname(paths.webrunEntryPath), "deno.json")}`);
        } else {
            args.push("--no-config");
        }
        args.push("--no-prompt", "--no-npm", "--no-check", "--no-lock");
    }

    // 4. Permission flags — derived from policy, no special cases.
    if (!isCheckOnly) {
        const permissions = buildPermissionSet(
            sys, policy, paths, os, networkFlags, envPermissions,
        );
        // @deprecated Legacy bridge: grant unrestricted --allow-run for testsys.Command.
        // Tests like bundling.test.ts create executables at arbitrary temp paths,
        // and globals.test.ts spawns Deno directly via t.testsys.execPath().
        if (input.legacyRunBin) {
            permissions.run = "*";  // unrestricted
            permissions.import = true;
        }
        args.push(...serializePermissions(permissions));
    }

    // 5. Entrypoint
    if (isCheckOnly) {
        args.push(invocation.targetScriptPath);
    } else {
        args.push(paths.webrunEntryPath);
        args.push("--internal-webrun-guest", payloadPath);
    }

    return args;
}
