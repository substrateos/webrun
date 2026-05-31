/**
 * Direct Sockets API — Type Definitions
 *
 * Follows the WICG Direct Sockets specification:
 * https://wicg.github.io/direct-sockets/
 *
 * This module defines the standard interface. Platform-specific
 * adapters (e.g. Deno, Node) provide concrete implementations.
 */

/** Options for creating a TCP socket connection. */
export interface TCPSocketOptions {
    /** Requested send buffer size in bytes. Platform default if omitted. */
    sendBufferSize?: number;
    /** Requested receive buffer size in bytes. Platform default if omitted. */
    receiveBufferSize?: number;
    /** Enable TCP_NODELAY (disable Nagle's algorithm). Default: false. */
    noDelay?: boolean;
    /** Enable SO_KEEPALIVE with this delay in milliseconds. Must be >= 1000. */
    keepAliveDelay?: number;
    /** Restrict DNS resolution to IPv4 or IPv6. OS default if omitted. */
    dnsQueryType?: "ipv4" | "ipv6";
}

/** Information about an opened TCP socket connection. */
export interface TCPSocketOpenInfo {
    /** Stream of bytes received from the remote host. */
    readable: ReadableStream<Uint8Array>;
    /** Stream for sending bytes to the remote host. */
    writable: WritableStream<Uint8Array>;
    /** Resolved remote address. */
    remoteAddress: string;
    /** Remote port. */
    remotePort: number;
    /** Local address bound by the OS. */
    localAddress: string;
    /** Local port assigned by the OS. */
    localPort: number;
}

/**
 * A TCP socket connection.
 *
 * Usage:
 *   const socket = new TCPSocket("127.0.0.1", 8443);
 *   const { readable, writable } = await socket.opened;
 *   await readable.pipeTo(destination);
 *   await socket.close();
 */
export interface TCPSocket {
    /** Resolves when the connection is established. */
    readonly opened: Promise<TCPSocketOpenInfo>;
    /** Resolves when the connection is fully closed. */
    readonly closed: Promise<void>;
    /** Initiate graceful close. */
    close(): Promise<void>;
}

/**
 * Factory for creating TCPSocket instances.
 * Adapters implement this to provide platform-specific sockets.
 */
export type TCPSocketConstructor = new (
    remoteAddress: string,
    remotePort: number,
    options?: TCPSocketOptions,
) => TCPSocket;
