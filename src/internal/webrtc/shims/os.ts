// node:os shim for the WebRTC bundle.
//
// werift only uses os.networkInterfaces() for ICE candidate discovery.
// This shim injects the real function via a one-shot initializer, keeping
// Deno.networkInterfaces off globalThis entirely.

// IMPORTANT: These variables must NOT have initializers. See dgram.ts
// for the full explanation of the esbuild __esm lazy-init clobbering bug.
let _networkInterfaces: (() => any) | undefined;
let initialized: boolean | undefined;

export function __initNetworkInterfaces(fn: () => any): void {
    if (initialized) throw new Error("Security Error: OS shim already initialized");
    initialized = true;
    _networkInterfaces = fn;

    // Self-destruct
    (globalThis as any).__initNetworkInterfaces = undefined;
}

export function networkInterfaces(): any {
    if (!_networkInterfaces) throw new Error("Security Error: networkInterfaces accessed before initialization");
    // Deno.networkInterfaces() returns a flat array of { name, address, family, ... }.
    // Node's os.networkInterfaces() returns { [name]: [{ address, family, ... }] }.
    // Convert Deno format to Node format for werift compatibility.
    const denoIfaces: any[] = _networkInterfaces();
    const result: Record<string, any[]> = {};
    for (const iface of denoIfaces) {
        const name = iface.name;
        if (!result[name]) result[name] = [];
        result[name].push({
            address: iface.address,
            netmask: iface.netmask,
            family: iface.family,
            mac: iface.mac,
            internal: iface.address === "127.0.0.1" || iface.address === "::1",
            cidr: iface.cidr,
        });
    }
    return result;
}

// Stubs for any other os methods werift might touch (defensive)
export function hostname(): string { return "sandbox"; }
export function type(): string { return ""; }
export function platform(): string { return ""; }
export function arch(): string { return ""; }
export function release(): string { return ""; }
export function tmpdir(): string { return "/tmp"; }
export function cpus(): any[] { return []; }
export function totalmem(): number { return 0; }
export function freemem(): number { return 0; }
export function uptime(): number { return 0; }
export function loadavg(): number[] { return [0, 0, 0]; }
export function endianness(): string { return "LE"; }
export const EOL = "\n";

export default {
    networkInterfaces,
    hostname, type, platform, arch, release, tmpdir,
    cpus, totalmem, freemem, uptime, loadavg, endianness, EOL,
    __initNetworkInterfaces,
};
