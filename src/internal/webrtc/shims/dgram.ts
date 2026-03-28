// IPC dgram proxy: fake Node.js dgram module that tunnels UDP operations
// through a MessagePort to the privileged host process.
//
// Security: The port is injected once via __initStrictUdpChannel and the
// initializer self-destructs. Guest code cannot access the IPC handle.

// IMPORTANT: These variables must NOT have initializers. esbuild's __esm
// lazy-init pattern places `var = <init>` inside a deferred callback that
// can run AFTER __initStrictUdpChannel has set hiddenPort, clobbering it.
// Bare `let` declarations hoist without an assignment in the __esm block.
let hiddenPort: MessagePort | undefined;
let initialized: boolean | undefined;

export function __initStrictUdpChannel(port: MessagePort) {
    if (initialized) throw new Error("Security Error: UDP channel already initialized");
    initialized = true;
    hiddenPort = port;
    hiddenPort.start();

    hiddenPort.addEventListener("message", (e: MessageEvent) => {
        const msg = e.data;
        if (!msg || !msg.socketId) return;

        const sock = socketRegistry.get(msg.socketId);
        if (!sock) return;

        switch (msg.type) {
            case "bound":
                sock._boundAddress = msg.address;
                sock.emit("listening");
                break;
            case "message":
                // Node dgram emits Buffer objects. werift calls Buffer-specific
                // methods (readUint16BE etc.) on the data, so must use Buffer.
                sock.emit("message", Buffer.from(msg.payload), {
                    address: msg.rinfo.address,
                    port: msg.rinfo.port,
                    family: msg.rinfo.family || "IPv4",
                    size: msg.payload.byteLength
                });
                break;
            case "error":
                sock.emit("error", new Error(msg.message));
                break;
        }
    });

    // Self-destruct the initializer so guest code cannot re-invoke it
    (globalThis as any).__initStrictUdpChannel = undefined;
}

let nextSocketId = 1;
const socketRegistry = new Map<number, Socket>();

type Listener = (...args: any[]) => void;

export class Socket {
    _type: string;
    _id: number;
    _listeners: Record<string, Listener[]> = {};
    _onceListeners: Record<string, Listener[]> = {};
    _boundAddress: { address: string; port: number; family: string } | null = null;
    _closed = false;

    constructor(type: string) {
        this._type = type;
        this._id = nextSocketId++;
        socketRegistry.set(this._id, this);
    }

    on(event: string, callback: Listener): this {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(callback);
        return this;
    }

    once(event: string, callback: Listener): this {
        if (!this._onceListeners[event]) this._onceListeners[event] = [];
        this._onceListeners[event].push(callback);
        return this;
    }

    removeListener(event: string, callback: Listener): this {
        if (this._listeners[event]) {
            this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
        }
        if (this._onceListeners[event]) {
            this._onceListeners[event] = this._onceListeners[event].filter(cb => cb !== callback);
        }
        return this;
    }

    removeAllListeners(event?: string): this {
        if (event) {
            delete this._listeners[event];
            delete this._onceListeners[event];
        } else {
            this._listeners = {};
            this._onceListeners = {};
        }
        return this;
    }

    emit(event: string, ...args: any[]): boolean {
        let handled = false;
        for (const cb of this._listeners[event] || []) {
            cb(...args);
            handled = true;
        }
        const onceCbs = this._onceListeners[event] || [];
        if (onceCbs.length > 0) {
            this._onceListeners[event] = [];
            for (const cb of onceCbs) {
                cb(...args);
                handled = true;
            }
        }
        return handled;
    }

    bind(portOrOpts?: number | { port?: number; address?: string }, address?: string): this {
        let bindPort = 0;
        let bindAddress: string | undefined;

        if (typeof portOrOpts === "object" && portOrOpts !== null) {
            bindPort = portOrOpts.port || 0;
            bindAddress = portOrOpts.address;
        } else if (typeof portOrOpts === "number") {
            bindPort = portOrOpts;
            bindAddress = address;
        }

        if (hiddenPort) {
            hiddenPort.postMessage({
                type: "bind",
                socketId: this._id,
                port: bindPort,
                address: bindAddress || (this._type === "udp6" ? "::" : "0.0.0.0")
            });
        }
        return this;
    }

    send(
        msg: Uint8Array,
        offsetOrPort: number,
        lengthOrAddress: number | string,
        portOrCallback?: number | Function,
        addressOrCallback?: string | Function,
        callback?: Function
    ): void {
        // Node dgram.send has multiple signatures. Werift uses:
        //   send(data, port, address, callback)
        // and also the standard Node form:
        //   send(data, offset, length, port, address, callback)
        let data: Uint8Array;
        let port: number;
        let addr: string;
        let cb: Function | undefined;

        if (typeof lengthOrAddress === "string") {
            // send(data, port, address, callback?)
            data = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
            port = offsetOrPort;
            addr = lengthOrAddress;
            cb = portOrCallback as Function | undefined;
        } else {
            // send(data, offset, length, port, address, callback?)
            const offset = offsetOrPort;
            const length = lengthOrAddress;
            data = new Uint8Array(
                msg instanceof Uint8Array ? msg.buffer : (msg as any).buffer,
                (msg as any).byteOffset + offset,
                length
            );
            port = portOrCallback as number;
            addr = addressOrCallback as string;
            cb = callback;
        }

        if (hiddenPort) {
            hiddenPort.postMessage({
                type: "send",
                socketId: this._id,
                msg: data,
                port,
                address: addr
            });
        }
        if (cb) cb();
    }

    address(): { address: string; port: number; family: string } {
        return this._boundAddress || {
            address: this._type === "udp6" ? "::" : "0.0.0.0",
            port: 0,
            family: this._type === "udp6" ? "IPv6" : "IPv4"
        };
    }

    close(callback?: Function): void {
        if (this._closed) return;
        this._closed = true;
        socketRegistry.delete(this._id);

        if (hiddenPort) {
            hiddenPort.postMessage({ type: "close", socketId: this._id });
        }

        if (callback) this.once("close", callback as Listener);
        // Emit close asynchronously like Node does
        Promise.resolve().then(() => this.emit("close"));
    }

    // No-ops for API compatibility
    setRecvBufferSize(_size: number): void {}
    setSendBufferSize(_size: number): void {}
    setBroadcast(_flag: boolean): void {}
    setMulticastTTL(_ttl: number): void {}
    setMulticastLoopback(_flag: boolean): void {}
    addMembership(_addr: string, _iface?: string): void {}
    dropMembership(_addr: string, _iface?: string): void {}
    ref(): this { return this; }
    unref(): this { return this; }
}

export function createSocket(typeOrOpts: string | { type: string }): Socket {
    const type = typeof typeOrOpts === "string" ? typeOrOpts : typeOrOpts.type;
    return new Socket(type);
}

// Default export for CJS-style imports
export default { createSocket, Socket };
