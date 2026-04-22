// webrun.ts — DI construction site. Captures globalThis.Deno and threads it.
import { spawnSandboxProcess } from "./src/host/mod.ts";
import { executeInsideSandbox } from "./src/guest.ts";
export { executeInsideSandbox };
export { parseRawArguments, parseCommandInvocation } from "./src/config.ts";

// =========================================================
// 5. GLOBAL ENTRYPOINT EVALUATION
// =========================================================

// Host-side UDP relay: creates a MessageChannel and manages real UDP sockets
// on behalf of the sandboxed guest. The guest only gets port1 (a MessagePort);
// actual network I/O happens here on the privileged side.
function setupUdpRelay(): { port1: MessagePort; cleanup: () => void } {
    const channel = new MessageChannel();
    const hostPort = channel.port2;
    const guestPort = channel.port1;

    const sockets = new Map<number, any>(); // socketId -> Deno.DatagramConn

    hostPort.addEventListener("message", async (e: MessageEvent) => {
        const msg = e.data;

        if (!msg || !msg.type) return;

        switch (msg.type) {
            case "bind": {
                try {

                    const conn = Deno.listenDatagram({
                        port: msg.port || 0,
                        hostname: msg.address || "127.0.0.1",
                        transport: "udp"
                    });
                    sockets.set(msg.socketId, conn);


                    hostPort.postMessage({
                        type: "bound",
                        socketId: msg.socketId,
                        address: {
                            address: (conn.addr as any).hostname,
                            port: (conn.addr as any).port,
                            family: "IPv4"
                        }
                    });

                    // Start async receive loop
                    (async () => {
                        try {
                            while (true) {
                                const [data, remoteAddr] = await conn.receive();
                                // data is a Uint8Array view into a pre-allocated 65507-byte
                                // receive buffer. Slice to extract only the actual packet bytes.
                                const packet = data.slice(0, data.byteLength);
                                hostPort.postMessage({
                                    type: "message",
                                    socketId: msg.socketId,
                                    payload: packet.buffer,
                                    rinfo: {
                                        address: (remoteAddr as any).hostname,
                                        port: (remoteAddr as any).port,
                                        family: "IPv4"
                                    }
                                });
                            }
                        } catch (_) {
                            // Socket was closed, receive loop ends
                        }
                    })();
                } catch (err: any) {
                    hostPort.postMessage({
                        type: "error",
                        socketId: msg.socketId,
                        message: err.message || String(err)
                    });
                }
                break;
            }
            case "send": {
                const conn = sockets.get(msg.socketId);
                if (conn) {
                    try {
                        const data = msg.msg instanceof Uint8Array ? msg.msg : new Uint8Array(msg.msg);
                        await conn.send(data, {
                            hostname: msg.address,
                            port: msg.port,
                            transport: "udp"
                        });
                    } catch (_) {
                        // Send failures are silently dropped (matches Node dgram behavior).
                    }
                }
                break;
            }
            case "close": {
                const conn = sockets.get(msg.socketId);
                if (conn) {
                    try { conn.close(); } catch (_) {}
                    sockets.delete(msg.socketId);
                }
                break;
            }
        }
    });
    hostPort.start();

    const cleanup = () => {
        for (const conn of sockets.values()) {
            try { conn.close(); } catch (_) {}
        }
        sockets.clear();
        try { hostPort.close(); } catch (_) {}
    };

    return { port1: guestPort, cleanup };
}

const isWorker = typeof (globalThis as any).WorkerGlobalScope !== 'undefined' && self instanceof (globalThis as any).WorkerGlobalScope;

if (!isWorker) {
    if (Deno.args.includes("--internal-webrun-guest")) {
        const payloadIndex = Deno.args.indexOf("--internal-webrun-guest");
        const payloadPath = Deno.args[payloadIndex + 1];
        const payloadData = JSON.parse(Deno.readTextFileSync(payloadPath));

        // Apply Landlock restrictions BEFORE any untrusted code loads.
        // This is the self-sandboxing step: the guest process restricts itself
        // irreversibly using the policy serialized by the host.
        if (payloadData.landlockPolicy && Deno.build.os === "linux") {
            const { applyLandlockJail } = await import("./src/landlock.ts");
            applyLandlockJail(payloadData.landlockPolicy);
        }

        if (payloadData.action === "test") {
            // WebRTC: only allocate the UDP relay when explicitly enabled.
            const webrtcEnabled = !!payloadData.config?.permissions?.webrtc;
            const relay = webrtcEnabled ? setupUdpRelay() : null;
            if (relay) payloadData.__udpPort = relay.port1;
            try {
                await executeInsideSandbox(globalThis.Deno, payloadData);
            } finally {
                relay?.cleanup();
            }
        } else {
            const webrtcEnabled = !!payloadData.config?.permissions?.webrtc;
            const relay = webrtcEnabled ? setupUdpRelay() : null;

            const workerCode = `
                import { executeInsideSandbox } from "${import.meta.url}";
                self.onmessage = async (e) => {
                    const sys = {
                        ...globalThis.Deno,
                        exit: (code) => {
                            self.postMessage({ type: "exit", code });
                            self.close();
                        }
                    };
                    try {
                        await executeInsideSandbox(sys, e.data);
                    } catch (err) {
                        console.error(err.message || String(err));
                        sys.exit(1);
                    }
                };
            `;
            const blobUrl = URL.createObjectURL(new Blob([workerCode], { type: "application/javascript" }));
            const worker = new Worker(blobUrl, { type: "module", name: "webrun-main", deno: { permissions: "inherit" } });
            
            worker.onmessage = (e) => {
                if (e.data && e.data.type === "exit") {
                    relay?.cleanup();
                    Deno.exit(e.data.code);
                }
            };
            worker.onerror = (e) => {
                relay?.cleanup();
                Deno.exit(1);
            };
            
            // Transfer the UDP port into the worker as a Transferable (only when WebRTC is enabled).
            const transferables: Transferable[] = [];
            if (relay) {
                payloadData.__udpPort = relay.port1;
                transferables.push(relay.port1);
            }
            worker.postMessage(payloadData, transferables);
            await new Promise(() => {}); // Wait forever until sys.exit is called
        }
    } else if (import.meta.main) {
        await spawnSandboxProcess(Deno, Deno.cwd(), Deno.args);
    }
}
