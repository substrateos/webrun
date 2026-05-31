// Guest-side WebRTC bootstrap.
// Imports the pre-compiled werift bundle (which has node:dgram, Buffer,
// setImmediate, clearImmediate, and node:os rewritten to injected shims
// at build time) and exposes RTCPeerConnection on globalThis.
//
// IMPORTANT: All initializers MUST be imported from the bundle, not from
// the raw source files. The bundle has its own module-scoped copies of the
// shims (aliased at build time). If we import from the source files
// directly, we'd initialize different module instances than the ones
// werift uses.

export interface WebRTCDeps {
    udpPort: MessagePort;
    Buffer: any;
    setImmediate: any;
    clearImmediate: any;
    process: any;
    networkInterfaces: () => any;
}

export async function bootstrapWebRTC(bundlePath: string, deps: WebRTCDeps): Promise<void> {
    const bundle = await import(`file://${bundlePath}`);
    
    // 1. Wire the dgram proxy's IPC channel (one-shot, self-destructs)
    bundle.__initStrictUdpChannel(deps.udpPort);

    // 2. Inject Node globals into the bundle's module scope (one-shot)
    bundle.__initNodeGlobals({
        Buffer: deps.Buffer,
        setImmediate: deps.setImmediate,
        clearImmediate: deps.clearImmediate,
        process: deps.process,
    });

    // 3. Inject networkInterfaces into the os shim (one-shot)
    bundle.__initNetworkInterfaces(deps.networkInterfaces);

    // 4. Expose WebRTC globals with sandbox-aware defaults.
    // werift's ICE gatherer filters out loopback addresses for candidates,
    // but the sandbox only permits loopback networking. Wrap the constructor
    // to auto-inject 127.0.0.1 as an additional host address so that ICE
    // host candidates are always generated without requiring users to know
    // about werift-specific config extensions.
    const SandboxedRTCPeerConnection = function(this: any, config?: any) {
        const patchedConfig = {
            ...(config || {}),
            iceAdditionalHostAddresses: [
                "127.0.0.1",
                ...(config?.iceAdditionalHostAddresses || []),
            ],
            // Disable IPv6: the sandbox only permits IPv4 loopback. IPv6 UDP
            // binds fail with permission errors, and since the dgram proxy
            // socket lacks error listeners the rejection hangs the ICE gatherer.
            iceUseIpv6: false,
        };
        return new bundle.RTCPeerConnection(patchedConfig);
    } as any;
    
    // Copy static properties and prototype so instanceof checks work
    SandboxedRTCPeerConnection.prototype = bundle.RTCPeerConnection.prototype;
    Object.setPrototypeOf(SandboxedRTCPeerConnection, bundle.RTCPeerConnection);

    const g = globalThis as any;
    g.RTCPeerConnection = SandboxedRTCPeerConnection;
    g.RTCSessionDescription = bundle.RTCSessionDescription;
    g.RTCIceCandidate = bundle.RTCIceCandidate;
}
