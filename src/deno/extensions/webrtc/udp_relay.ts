interface NetAddr {
    /** The network protocol family name (e.g., "udp", "tcp"). */
    transport: "tcp" | "udp";
    /** The IP address or hostname string. */
    hostname: string;
    /** The destination or origin port number. */
    port: number;
}

interface DatagramConn extends AsyncIterable<[Uint8Array, NetAddr]> {
    readonly addr: NetAddr;

    /** The local address of the datagram connection socket. */
    readonly localAddr: NetAddr;

    /**
     * Receives a single packet from the socket.
     * Resolves with an array containing the data buffer and the remote sender's address.
     */
    receive(): Promise<[Uint8Array, NetAddr]>;

    /**
     * Sends a datagram packet to a remote address.
     * 
     * @param payload The raw byte array data to transmit.
     * @param addr The remote destination network address.
     * @returns A promise that resolves when the data has been successfully sent.
     */
    send(payload: Uint8Array, addr: NetAddr): Promise<void>;

    /** Closes the socket and releases the underlying system resources. */
    close(): void;

    /** Support for the `for await...of` loop protocol. */
    [Symbol.asyncIterator](): AsyncIterator<[Uint8Array, NetAddr]>;
}

interface ListenDatagramOptions {
    /** The transport protocol to use. Currently, only "udp" is supported. */
    transport: "udp";
    /** The local port to bind to and listen on. */
    port: number;
    /** The local hostname or IP address to bind to. Defaults to "0.0.0.0". */
    hostname?: string;
}

type ListenDatagram = (options: ListenDatagramOptions) => DatagramConn;

export interface UDPRelayDeps {
    listenDatagram: ListenDatagram
}


// UDP relay: creates a MessageChannel and manages real UDP sockets
// on behalf of the sandboxed guest. The guest only gets port1 (a MessagePort);
// actual network I/O happens here on the privileged side.
export default function makeUdpRelay(deps: UDPRelayDeps): { port1: MessagePort; cleanup: () => void } {
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
                    const conn = deps.listenDatagram({
                        port: msg.port || 0,
                        hostname: msg.address || "127.0.0.1",
                        transport: "udp"
                    });
                    sockets.set(msg.socketId, conn);

                    hostPort.postMessage({
                        type: "bound",
                        socketId: msg.socketId,
                        address: {
                            address: conn.addr.hostname,
                            port: conn.addr.port,
                            family: "IPv4"
                        }
                    });

                    // Start async receive loop
                    (async () => {
                        for await (const [data, remoteAddr] of conn) {
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
                    try { conn.close(); } catch (_) { }
                    sockets.delete(msg.socketId);
                }
                break;
            }
        }
    });
    hostPort.start();

    const cleanup = () => {
        for (const conn of sockets.values()) {
            try { conn.close(); } catch (_) { }
        }
        sockets.clear();
        try { hostPort.close(); } catch (_) { }
    };

    return { port1: guestPort, cleanup };
}
