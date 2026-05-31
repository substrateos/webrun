// =========================================================
// OS ADAPTER: macOS Seatbelt (sandbox_init_with_parameters)
//
// Self-sandboxes the current process using the macOS sandbox
// C API via FFI. Translates the platform-neutral
// ResolvedCapabilities into seatbelt-native SBPL profiles.
// =========================================================

import type { ResolvedCapabilities } from "../../capabilities.ts";

/**
 * Paths already present in the seatbelt template (lines 96-111).
 * These use the correct (literal ...) or (subpath ...) directives
 * and must not be duplicated as (subpath ...) in the enclaves.
 */
const TEMPLATE_SYSTEM_PATHS = new Set([
    "/usr/lib", "/usr/local/lib", "/System/Library", "/opt/homebrew",
    "/dev/random", "/dev/urandom", "/dev/null", "/dev/tty",
    "/etc/resolv.conf", "/etc/hosts",
    "/private/etc/resolv.conf", "/private/etc/hosts",
    "/private/etc/services", "/private/var/run/mDNSResponder",
]);

/**
 * Returns the appropriate seatbelt directive for a path.
 * Files get (literal ...), directories get (subpath ...).
 * Heuristic: paths containing a dot in the final segment are files.
 */
function seatbeltDirective(path: string): string {
    const lastSlash = path.lastIndexOf("/");
    const basename = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;
    const isFile = basename.includes(".") && !basename.startsWith(".");
    return isFile ? `(literal "${path}")` : `(subpath "${path}")`;
}

/**
 * Pure translator: ResolvedCapabilities → Seatbelt enclave strings.
 * Skips system paths already hardcoded in the profile template,
 * and uses (literal ...) for file paths vs (subpath ...) for directories.
 */
export function toSeatbeltEnclaves(caps: ResolvedCapabilities): { readEnclaves: string, writeEnclaves: string } {
    let readEnclaves = "";
    for (const cp of caps.readPaths) {
        if (TEMPLATE_SYSTEM_PATHS.has(cp.path)) continue;
        readEnclaves += `\n    ${seatbeltDirective(cp.path)}`;
    }

    let writeEnclaves = "";
    for (const cp of caps.writePaths) {
        if (TEMPLATE_SYSTEM_PATHS.has(cp.path)) continue;
        writeEnclaves += `\n    ${seatbeltDirective(cp.path)}`;
    }

    return { readEnclaves, writeEnclaves };
}

/**
 * Generates the raw macOS Sandbox (Seatbelt) Policy Scheme (.sb) profile.
 *
 * All values are inlined directly into the generated profile string —
 * no `-D` parameter indirection needed since the profile
 * is ephemeral (generated per-invocation).
 */
export function toSeatbeltPolicy(
    caps: ResolvedCapabilities,
): string {
    const { readEnclaves, writeEnclaves } = toSeatbeltEnclaves(caps);

    // Ephemeral ports: allow localhost connect + bind for proxy/relay ports.
    let extraNetworkOutbound = "";
    let extraNetworkInbound = "";
    for (const port of caps.localNetworkConnectPorts) {
        extraNetworkOutbound += `\n    (remote tcp "localhost:${port}")`;
    }
    for (const port of caps.localNetworkBindPorts) {
        extraNetworkInbound += `\n    (local tcp "*:${port}")\n    (local tcp "localhost:${port}")`;
    }

    // Unix socket outbound: allow the sandbox to connect to unix sockets (spawner, etc.).
    let socketOutbound = "";
    for (const p of caps.outboundSocketPaths) {
        socketOutbound += `\n    (literal "${p}")`;
    }

    // OS-level network gating. The seatbelt can only distinguish "no network"
    // from "any network" — it accepts only * or localhost as host values, and
    // cannot filter by port range or specific host. Per-host filtering is
    // handled by the runtime's --allow-net/--deny-net flags. The seatbelt
    // provides defense-in-depth: if permissions.network is empty, the OS
    // blocks all outbound TCP/UDP regardless of runtime state.
    const hasNetwork = caps.remoteNetworkConnectHosts.length > 0 || caps.remoteNetworkBindHosts.length > 0;
    if (hasNetwork) {
        extraNetworkOutbound += `\n    (remote tcp "*:*")\n    (remote udp "*:*")`;
        extraNetworkInbound += `\n    (local tcp "*:*")\n    (local udp "*:*")`;
    }

    let inboundBlock = "";
    if (extraNetworkInbound) {
        inboundBlock = `\n(allow network-inbound network-bind${extraNetworkInbound}\n)`;
    }

    // Process-exec: allow executing the runtime binary.
    const execLiterals = caps.execPaths
        .map(p => `    (literal "${p.path}")`)
        .join("\n");

    // Exec dir: allow reading and mapping shared libs from the runtime dir.
    const execDirs = [...new Set(caps.execPaths.map(p => p.path.substring(0, p.path.lastIndexOf("/")) || "/"))];
    const execDirSubpaths = execDirs
        .map(d => `    (subpath "${d}")`)
        .join("\n");

    return `(version 1)
(deny default)
(import "bsd.sb")
(allow file-read-metadata)
(allow signal)
(allow system-fsctl)
(deny process-exec)
${caps.run ? `(allow process-fork)\n(allow system-privilege)` : '(deny process-fork)'}
${caps.gpu ? `
(allow iokit-open)
(allow file-issue-extension)
(allow user-preference-read)` : ""}

(allow process-exec
${execLiterals}
)

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
    (subpath "/usr/lib")
    (subpath "/usr/local/lib")
    (subpath "/System/Library")
    (subpath "/opt/homebrew")
${execDirSubpaths}
)

(allow system-socket)
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
${inboundBlock}
(allow network-outbound
    (remote udp "*:53")
    (literal "/private/var/run/mDNSResponder")${extraNetworkOutbound}${socketOutbound}
)
(allow file-read* file-write*${caps.gpu ? `\n    (regex #"^/private/var/folders/.*$")` : ""}${writeEnclaves}
)

(allow file-read*${readEnclaves}
)

(deny file-read* file-write*
    (regex #"^.*/\\\\.env.*$")
)
`;
}

