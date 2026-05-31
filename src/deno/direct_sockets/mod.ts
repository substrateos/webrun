/**
 * Direct Sockets — Deno Adapter
 *
 * Implements TCPSocket backed by Deno.connect(). The Deno
 * runtime is injected as a typed interface — no global Deno
 * reference, matching the pattern used in fs.ts.
 */

import type {
    TCPSocket,
    TCPSocketConstructor,
    TCPSocketOpenInfo,
    TCPSocketOptions,
} from "../../core/direct_sockets/types.ts";

// ── Injected Deno surface ───────────────────────────────────────────────────

/** Precisely the Deno APIs we need — nothing more. */
export interface DenoNetRuntime {
    connect(options: {
        hostname: string;
        port: number;
        transport: "tcp";
    }): Promise<{
        readonly readable: ReadableStream<Uint8Array>;
        readonly writable: WritableStream<Uint8Array>;
        readonly localAddr: { hostname: string; port: number };
        readonly remoteAddr: { hostname: string; port: number };
        close(): void;
    }>;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates Direct Sockets implementations backed by the given Deno runtime.
 *
 * Usage:
 *   const { TCPSocket } = makeDirectSockets({ connect: Deno.connect.bind(Deno) });
 *   const sock = new TCPSocket("127.0.0.1", 8443);
 *   const { readable, writable } = await sock.opened;
 */
export function makeDirectSockets(rt: DenoNetRuntime): { TCPSocket: TCPSocketConstructor } {
    const TCPSocket: TCPSocketConstructor = class DenoTCPSocket implements TCPSocket {
        readonly opened: Promise<TCPSocketOpenInfo>;
        readonly closed: Promise<void>;

        #closeResolve!: () => void;
        #closeReject!: (err: Error) => void;
        #conn: { close(): void } | null = null;

        constructor(
            remoteAddress: string,
            remotePort: number,
            _options?: TCPSocketOptions,
        ) {
            this.closed = new Promise<void>((resolve, reject) => {
                this.#closeResolve = resolve;
                this.#closeReject = reject;
            });

            this.opened = this.#open(remoteAddress, remotePort);
        }

        async #open(
            remoteAddress: string,
            remotePort: number,
        ): Promise<TCPSocketOpenInfo> {
            try {
                const conn = await rt.connect({
                    hostname: remoteAddress,
                    port: remotePort,
                    transport: "tcp",
                });
                this.#conn = conn;

                return {
                    readable: conn.readable,
                    writable: conn.writable,
                    remoteAddress: conn.remoteAddr.hostname,
                    remotePort: conn.remoteAddr.port,
                    localAddress: conn.localAddr.hostname,
                    localPort: conn.localAddr.port,
                };
            } catch (err) {
                const error = err instanceof Error
                    ? err
                    : new Error(String(err));
                this.#closeReject(error);
                throw error;
            }
        }

        async close(): Promise<void> {
            try {
                this.#conn?.close();
            } catch { /* already closed */ }
            this.#closeResolve();
        }
    };

    return { TCPSocket };
}
