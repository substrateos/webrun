import type { ResolvedCapabilities } from "../../core/capabilities.ts";

/** Declarative representation of Deno permission flags. Single source of truth. */
interface DenoPermissionSet {
    read: string[] | "*";
    write: string[] | "*";
    net: string[] | "*";
    denyNet: boolean;
    env: string[] | "*";
    run: string[] | "*";
    ffi: boolean;
    sys: string[];
    import: string[] | "*" | false;
}

/** Converts a DenoPermissionSet into Deno CLI --allow-* / --deny-* flags. */
function serializePermissions(p: DenoPermissionSet): string[] {
    const flags: string[] = [];

    if (p.read === "*") flags.push("--allow-read");
    else if (p.read.length > 0) flags.push(`--allow-read=${p.read.join(",")}`);

    if (p.write === "*") flags.push("--allow-write");
    else if (p.write.length > 0) flags.push(`--allow-write=${p.write.join(",")}`);

    // Network flags
    if (p.denyNet) {
        flags.push("--deny-net");
    } else if (p.net === "*") {
        flags.push("--allow-net");
    } else if (p.net.length > 0) {
        flags.push(`--allow-net=${p.net.join(",")}`);
    }

    if (p.env === "*") flags.push("--allow-env");
    else if (p.env.length > 0) flags.push(`--allow-env=${p.env.join(",")}`);

    if (p.run === "*") flags.push("--allow-run");
    else if (p.run.length > 0) flags.push(`--allow-run=${p.run.join(",")}`);

    if (p.ffi) flags.push("--allow-ffi");
    if (p.sys.length > 0) flags.push(`--allow-sys=${p.sys.join(",")}`);
    if (p.import === "*") {
        flags.push("--allow-import");
    } else if (p.import && p.import.length > 0) {
        flags.push(`--allow-import=${p.import.join(",")}`);
    }

    return flags;
}

/**
 * Pure translator: ResolvedCapabilities → DenoPermissionSet.
 * Builds Deno network flags from connect/bind hosts and local ports.
 */
export default function toDenoFlags(caps: ResolvedCapabilities): string[] {
    const hasUserNetwork = caps.remoteNetworkConnectHosts.length > 0 || caps.remoteNetworkBindHosts.length > 0;
    const hasWildcard = caps.remoteNetworkConnectHosts.includes("*");

    // Build --allow-net entries: user hosts + local infrastructure ports.
    let net: string[] | "*" = [];
    let denyNet = false;

    if (hasWildcard) {
        net = "*";
    } else if (hasUserNetwork) {
        net = [
            ...caps.remoteNetworkConnectHosts,
            ...caps.remoteNetworkBindHosts,
            ...caps.localNetworkConnectPorts.map(p => `127.0.0.1:${p}`),
            ...caps.localNetworkBindPorts.map(p => `127.0.0.1:${p}`),
        ];
    } else if (caps.localNetworkConnectPorts.length > 0 || caps.localNetworkBindPorts.length > 0) {
        net = [
            ...caps.localNetworkConnectPorts.map(p => `127.0.0.1:${p}`),
            ...caps.localNetworkBindPorts.map(p => `127.0.0.1:${p}`),
        ];
    } else {
        denyNet = true;
    }

    // Import hosts
    const netFlags = hasWildcard ? "*" : [
        ...caps.remoteNetworkConnectHosts,
        ...caps.remoteNetworkBindHosts,
        ...caps.localNetworkConnectPorts.map(p => `127.0.0.1:${p}`),
        ...caps.localNetworkBindPorts.map(p => `0.0.0.0:${p}`), // Deno server binds need 0.0.0.0
    ];

    const importWildcard = caps.importHosts.length === 1 && caps.importHosts[0] === "*";
    let importPerm: string[] | "*" | false = false;
    if (importWildcard) importPerm = "*";
    else if (caps.importHosts.length > 0) importPerm = caps.importHosts;

    const read = caps.readPaths.map(p => p.path);
    const write = caps.writePaths.map(p => p.path);

    return serializePermissions({
        read: read.length === 0 ? [] : read,
        write: write.length === 0 ? [] : write,
        net: netFlags === "*" ? "*" : (netFlags.length > 0 ? netFlags : []),
        denyNet: netFlags !== "*" && netFlags.length === 0,
        env: caps.env === "*" ? "*" : caps.env,
        run: caps.runPaths,
        ffi: caps.ffi,
        sys: ["osRelease", "networkInterfaces"],
        import: importPerm,
    });
}

/**
 * Pure translator: ResolvedCapabilities → Deno Worker permissions object.
 * Used to create Workers with explicit permissions rather than "inherit".
 */
export function toDenoPermissionsObject(caps: ResolvedCapabilities): Deno.PermissionOptions {
    const hasUserNetwork = caps.remoteNetworkConnectHosts.length > 0 || caps.remoteNetworkBindHosts.length > 0;
    const hasWildcard = caps.remoteNetworkConnectHosts.includes("*");

    let net: string[] | boolean;
    if (hasWildcard) {
        net = true;
    } else if (hasUserNetwork || caps.localNetworkConnectPorts.length > 0 || caps.localNetworkBindPorts.length > 0) {
        net = [
            ...caps.remoteNetworkConnectHosts,
            ...caps.remoteNetworkBindHosts,
            ...caps.localNetworkConnectPorts.map(p => `127.0.0.1:${p}`),
            ...caps.localNetworkBindPorts.map(p => `0.0.0.0:${p}`),
        ];
    } else {
        net = false;
    }

    const env: string[] | boolean = caps.env === "*" ? true
        : caps.env.length > 0 ? caps.env
        : false;

    const read: string[] | boolean = caps.readPaths.length > 0 ? caps.readPaths.map(p => p.path) : false;
    const write: string[] | boolean = caps.writePaths.length > 0 ? caps.writePaths.map(p => p.path) : false;

    const importWildcard = caps.importHosts.length === 1 && caps.importHosts[0] === "*";
    const importPerm: string[] | boolean = importWildcard ? true
        : caps.importHosts.length > 0 ? caps.importHosts
        : false;

    return {
        read,
        write,
        net,
        env,
        run: false,
        ffi: caps.ffi,
        sys: ["networkInterfaces"] as unknown as boolean,
        import: importPerm,
    };
}

/**
 * Revokes Deno runtime permissions for each capability in `drop`.
 * Called after OS jail setup to strip jail-only privileges.
 *
 * Revocation is permanent — once revoked, permissions cannot be re-granted
 * within the same process.
 */
export async function revokePermissions(drop: Partial<ResolvedCapabilities>): Promise<void> {
    if (drop.ffi === false) {
        await Deno.permissions.revoke({ name: "ffi" });
    }
    if (drop.run === false) {
        await Deno.permissions.revoke({ name: "run" });
    }
    for (const cp of drop.readPaths || []) {
        await Deno.permissions.revoke({ name: "read", path: cp.path });
    }
    for (const cp of drop.writePaths || []) {
        await Deno.permissions.revoke({ name: "write", path: cp.path });
    }
}
