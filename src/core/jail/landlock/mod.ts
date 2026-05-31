/**
 * Landlock policy types and pure translator.
 *
 * Converts platform-neutral ResolvedCapabilities into the
 * Landlock-specific policy format. No FFI, no Deno dependency.
 */

import type { CapabilityPath, ResolvedCapabilities } from "../../capabilities.ts";

/** Landlock policy for Linux self-sandboxing (serialized into the sandbox payload). */
export interface LandlockPolicy {
    /** Paths the guest may read (canonicalized). */
    read_paths: CapabilityPath[];
    /** Paths the guest may write (canonicalized). */
    write_paths: CapabilityPath[];
    /** Paths the guest may execute (typically just the runtime binary). */
    exec_paths: CapabilityPath[];
    /** TCP ports the guest may connect to (defense-in-depth, ABI 4+). null = unrestricted (e.g. for network: "*"). */
    tcp_connect_ports: number[] | null;
    /** TCP ports the guest may bind. null = unrestricted (e.g. serve/mux needs ephemeral ports). */
    tcp_bind_ports: number[] | null;
    /** Whether GPU device access is allowed (ABI 5+). */
    gpu: boolean;
}

/**
 * Pure translator: ResolvedCapabilities → LandlockPolicy.
 * No path resolution, no file-extension checks — just format conversion.
 */
export function toLandlockPolicy(caps: ResolvedCapabilities): LandlockPolicy {

    // Landlock operates at port level — combine local infrastructure ports
    // with well-known ports when user has declared network hosts.
    const hasNetwork = caps.remoteNetworkConnectHosts.length > 0;
    const hasWildcard = caps.remoteNetworkConnectHosts.includes("*");
    const hasBindHosts = caps.remoteNetworkBindHosts.length > 0;
    const connectPorts = hasWildcard ? null : [
        ...caps.localNetworkConnectPorts,
        ...(hasNetwork ? [80, 443] : []),
    ];
    // When bind hosts are present (e.g. for mux/serve), allow any port binding.
    // Landlock's port-based model cannot express "bind to any port on 127.0.0.1",
    // so we leave tcp_bind_ports null to signal that bind should not be restricted.
    const bindPorts = hasBindHosts ? null : [
        ...caps.localNetworkBindPorts,
    ];

    return {
        read_paths: caps.readPaths,
        write_paths: caps.writePaths,
        exec_paths: caps.execPaths,
        tcp_connect_ports: connectPorts,
        tcp_bind_ports: bindPorts,
        gpu: caps.gpu,
    };
}
