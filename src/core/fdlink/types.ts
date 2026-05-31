/**
 * fdlink — type definitions.
 *
 * Connection-oriented IPC over Unix domain sockets with
 * SCM_RIGHTS fd-passing. Follows the TransformStream (Pipe shape)
 * and Direct Sockets (opened/closed lifecycle) patterns.
 *
 * This module is pure — no platform imports.
 */

/**
 * A pipe pair — same shape as TransformStream.
 *
 * Data written to `writable` appears on `readable`.
 * The two ends may be in different processes after transfer.
 */
export interface Pipe {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
}

/**
 * An inert handle to a transferred file descriptor.
 *
 * Received via SCM_RIGHTS on a Connection. The FD is untouched
 * until the receiver activates it as readable or writable.
 * Same lazy-activation pattern as Deno.FsFile.
 */
export interface TransferHandle {
    /** Activate as a ReadableStream (pull-based, lazy). */
    readonly readable: ReadableStream<Uint8Array>;
    /** Activate as a WritableStream. */
    readonly writable: WritableStream<Uint8Array>;
    /** Close the underlying FD without creating a stream. */
    close(): void;
}

/**
 * A Unix domain socket connection with fd-passing.
 *
 * Usage:
 *   const conn = transport.connect("/tmp/spawner.sock");
 *   conn.send(data, [pipe.writable]);
 *   const { data, transferred } = conn.receive();
 *   conn.close();
 */
export interface Connection {
    /** Send data, optionally transferring pipe ends via SCM_RIGHTS.
     *  Transferred streams are consumed — the local reference is neutered.
     *  @throws {ConnectionClosed} if the connection has been closed. */
    send(data: Uint8Array, transfer?: (ReadableStream<Uint8Array> | WritableStream<Uint8Array>)[]): void;
    /** Receive data + any transferred handles (blocking). */
    receive(): { data: Uint8Array; transferred: TransferHandle[] };
    /** Receive data (async, blocking read on background thread). */
    receiveAsync(): Promise<{ data: Uint8Array; transferred: TransferHandle[] }>;
    /** Resolves when the connection is fully closed. */
    readonly closed: Promise<void>;
    /** Close the connection. */
    close(): void;
}

/** A listening Unix domain socket that accepts connections. */
export interface Listener {
    /** Accept the next incoming connection (async). */
    accept(): Promise<Connection>;
    /** Resolves when the listener is fully closed. */
    readonly closed: Promise<void>;
    /** Close the listener and remove the socket file. */
    close(): void;
}

/** fdlink transport factory — creates connections, listeners, and pipes. */
export interface Transport {
    /** Connect to a Unix domain socket at the given path. */
    connect(path: string): Connection;
    /** Listen on a Unix domain socket at the given path. */
    listen(path: string): Listener;
    /** Create a pipe pair (same shape as TransformStream). */
    pipe(): Pipe;
}

/** Private symbol for raw FD access on streams created by fdlink. */
const FD = Symbol("fd");

/** Attach a raw file descriptor to a stream. Internal to fdlink. */
export function attachFd(stream: ReadableStream<Uint8Array> | WritableStream<Uint8Array>, fd: number): void {
    Object.defineProperty(stream, FD, { value: fd });
}

/** Retrieve the raw file descriptor from a stream created by fdlink. */
export function getFd(stream: ReadableStream<Uint8Array> | WritableStream<Uint8Array>): number {
    const fd = (stream as any)[FD];
    if (fd === undefined) throw new Error("Stream has no associated file descriptor");
    return fd;
}

/** Thrown when an operation is attempted on a closed connection. */
export class ConnectionClosed extends Error {
    constructor() { super("Connection closed"); this.name = "ConnectionClosed"; }
}
