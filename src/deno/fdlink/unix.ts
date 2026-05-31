/**
 * fdlink — Unix domain socket transport with SCM_RIGHTS fd-passing.
 *
 * All Deno FFI surface is injected via makeFdlink() — this module
 * contains no ambient Deno global access.
 */

import type { Transport, Connection, Listener, Pipe, TransferHandle } from "../../core/fdlink/types.ts";
import { attachFd, getFd, ConnectionClosed } from "../../core/fdlink/types.ts";

/** Opaque pointer value — structurally bigint | null. */
type PointerValue = bigint | null;

/** The Deno APIs that fdlink actually needs. */
export interface FdlinkDeps {
    build: { os: string };
    dlopen(
        path: string,
        symbols: Record<string, {
            parameters: readonly string[];
            result: string;
            nonblocking?: boolean;
        }>,
    ): { symbols: Record<string, (...args: any[]) => any> };
    UnsafePointer: {
        of(buf: ArrayBufferView & { buffer: ArrayBuffer }): PointerValue;
        value(ptr: NonNullable<PointerValue>): bigint;
    };
    UnsafePointerView: {
        new(ptr: NonNullable<PointerValue>): { getCString(): string; getInt32(): number };
    };
}

export function makeFdlink(Deno: FdlinkDeps): Transport {

// ─── Platform detection ───

const IS_DARWIN = Deno.build.os === "darwin";
const LIBC_PATH = IS_DARWIN ? "libSystem.B.dylib" : "libc.so.6";

// ─── SCM_RIGHTS constants (platform-specific) ───

const SOL_SOCKET = IS_DARWIN ? 0xffff : 1;
const SCM_RIGHTS = IS_DARWIN ? 0x01 : 0x01;

// ─── struct msghdr layout (platform-specific) ───

const MSGHDR_SIZE = IS_DARWIN ? 48 : 56;
const MSGHDR_IOV_OFFSET = 16;
const MSGHDR_IOVLEN_OFFSET = 24;
const MSGHDR_CONTROL_OFFSET = 32;
const MSGHDR_CONTROLLEN_OFFSET = 40;
const MSGHDR_FLAGS_OFFSET = IS_DARWIN ? 44 : 48;

const IOVEC_SIZE = 16;

const CMSG_HEADER_SIZE = IS_DARWIN ? 12 : 16;
const CMSG_LEVEL_OFFSET = IS_DARWIN ? 4 : 8;
const CMSG_TYPE_OFFSET = IS_DARWIN ? 8 : 12;
const CMSG_DATA_OFFSET = CMSG_HEADER_SIZE;
const CMSG_ALIGN = IS_DARWIN ? 4 : 8;

// ─── Lazy FFI handle ───

interface LibC {
    pipe(fds: PointerValue): number;
    close(fd: number): number;
    sendmsg(sockFd: number, msg: PointerValue, flags: number): number;
    recvmsg(sockFd: number, msg: PointerValue, flags: number): number;
    write(fd: number, buf: PointerValue, count: number): number;
    read(fd: number, buf: PointerValue, count: number): number;
    socket(domain: number, type: number, protocol: number): number;
    connect(sockFd: number, addr: PointerValue, addrLen: number): number;
    bind(sockFd: number, addr: PointerValue, addrLen: number): number;
    listen(sockFd: number, backlog: number): number;
    accept(sockFd: number, addr: PointerValue, addrLen: PointerValue): number;
    unlink(path: PointerValue): number;
    errno(): number;
    strerror(errnum: number): PointerValue;
}

let _libc: LibC | null = null;

function getLibC(): LibC {
    if (_libc) return _libc;

    const lib = Deno.dlopen(LIBC_PATH, {
        pipe: { parameters: ["pointer"], result: "i32" },
        close: { parameters: ["i32"], result: "i32" },
        sendmsg: { parameters: ["i32", "pointer", "i32"], result: "isize" },
        recvmsg: { parameters: ["i32", "pointer", "i32"], result: "isize" },
        write: { parameters: ["i32", "pointer", "usize"], result: "isize" },
        read: { parameters: ["i32", "pointer", "usize"], result: "isize" },
        socket: { parameters: ["i32", "i32", "i32"], result: "i32" },
        connect: { parameters: ["i32", "pointer", "u32"], result: "i32" },
        bind: { parameters: ["i32", "pointer", "u32"], result: "i32" },
        listen: { parameters: ["i32", "i32"], result: "i32" },
        accept: { parameters: ["i32", "pointer", "pointer"], result: "i32" },
        unlink: { parameters: ["pointer"], result: "i32" },
        strerror: { parameters: ["i32"], result: "pointer" },
        ...(IS_DARWIN
            ? { __error: { parameters: [], result: "pointer" } }
            : { __errno_location: { parameters: [], result: "pointer" } }),
    });

    _libc = {
        pipe: (fds) => lib.symbols.pipe(fds) as number,
        close: (fd) => lib.symbols.close(fd) as number,
        sendmsg: (sockFd, msg, flags) => lib.symbols.sendmsg(sockFd, msg, flags) as number,
        recvmsg: (sockFd, msg, flags) => lib.symbols.recvmsg(sockFd, msg, flags) as number,
        write: (fd, buf, count) => lib.symbols.write(fd, buf, count) as number,
        read: (fd, buf, count) => lib.symbols.read(fd, buf, count) as number,
        socket: (d, t, p) => lib.symbols.socket(d, t, p) as number,
        connect: (fd, addr, len) => lib.symbols.connect(fd, addr, len) as number,
        bind: (fd, addr, len) => lib.symbols.bind(fd, addr, len) as number,
        listen: (fd, backlog) => lib.symbols.listen(fd, backlog) as number,
        accept: (fd, addr, addrLen) => lib.symbols.accept(fd, addr, addrLen) as number,
        unlink: (path) => lib.symbols.unlink(path) as number,
        errno: () => {
            const fn = IS_DARWIN ? lib.symbols.__error : lib.symbols.__errno_location;
            const ptr = fn() as PointerValue;
            return new Deno.UnsafePointerView(ptr!).getInt32();
        },
        strerror: (errnum) => lib.symbols.strerror(errnum) as PointerValue,
    };

    return _libc;
}

/** Get a human-readable error message for the current errno. */
function errnoMessage(): string {
    const libc = getLibC();
    const e = libc.errno();
    const ptr = libc.strerror(e);
    const msg = ptr ? new Deno.UnsafePointerView(ptr).getCString() : "unknown";
    return `${msg} (errno ${e})`;
}

// ─── AF_UNIX socket constants ───

const AF_UNIX = 1;
const SOCK_STREAM = 1;

const SOCKADDR_UN_SIZE = IS_DARWIN ? 106 : 110;
const SUN_PATH_OFFSET = IS_DARWIN ? 2 : 2;
const SUN_PATH_MAX = IS_DARWIN ? 104 : 108;

const MSG_CTRUNC = IS_DARWIN ? 0x20 : 0x08;

function makeSockaddrUn(path: string): Uint8Array<ArrayBuffer> {
    const encoder = new TextEncoder();
    const pathBytes = encoder.encode(path);
    if (pathBytes.length >= SUN_PATH_MAX) {
        throw new Error(`Socket path too long: ${path} (max ${SUN_PATH_MAX - 1} bytes)`);
    }

    const buf = new Uint8Array(SOCKADDR_UN_SIZE) as Uint8Array<ArrayBuffer>;
    if (IS_DARWIN) {
        buf[0] = SOCKADDR_UN_SIZE; // sun_len
        buf[1] = AF_UNIX;          // sun_family
    } else {
        buf[0] = AF_UNIX;           // sun_family (little-endian u16)
        buf[1] = 0;
    }
    buf.set(pathBytes, SUN_PATH_OFFSET);
    return buf;
}

// ─── Raw FD operations (internal) ───

function rawPipe(): [number, number] {
    const fds = new Int32Array(2);
    const buf = new Uint8Array(fds.buffer) as Uint8Array<ArrayBuffer>;
    const result = getLibC().pipe(Deno.UnsafePointer.of(buf));
    if (result !== 0) throw new Error(`pipe() failed: ${errnoMessage()}`);
    return [fds[0], fds[1]];
}

function rawClose(fd: number): void {
    getLibC().close(fd);
}

function rawConnectUnix(path: string): number {
    const libc = getLibC();
    const fd = libc.socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) throw new Error(`socket() failed: ${errnoMessage()}`);

    const addr = makeSockaddrUn(path);
    const result = libc.connect(fd, Deno.UnsafePointer.of(addr), addr.length);
    if (result < 0) {
        libc.close(fd);
        throw new Error(`connect("${path}") failed: ${errnoMessage()}`);
    }
    return fd;
}

function rawListenUnix(path: string): number {
    const libc = getLibC();

    const pathBuf = new TextEncoder().encode(path + "\0");
    const pathArr = new Uint8Array(pathBuf.buffer) as Uint8Array<ArrayBuffer>;
    libc.unlink(Deno.UnsafePointer.of(pathArr));

    const fd = libc.socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) throw new Error(`socket() failed: ${errnoMessage()}`);

    const addr = makeSockaddrUn(path);
    let result = libc.bind(fd, Deno.UnsafePointer.of(addr), addr.length);
    if (result < 0) {
        libc.close(fd);
        throw new Error(`bind("${path}") failed: ${errnoMessage()}`);
    }

    result = libc.listen(fd, 16);
    if (result < 0) {
        libc.close(fd);
        throw new Error(`listen("${path}") failed: ${errnoMessage()}`);
    }

    return fd;
}

// ─── Async accept ───

let _asyncAcceptLib: { accept: (fd: number, addr: PointerValue, len: PointerValue) => Promise<number> } | null = null;

function getAsyncAcceptLib() {
    if (_asyncAcceptLib) return _asyncAcceptLib;
    const lib = Deno.dlopen(LIBC_PATH, {
        accept: { parameters: ["i32", "pointer", "pointer"], result: "i32", nonblocking: true },
    });
    _asyncAcceptLib = {
        accept: (fd, addr, len) => lib.symbols.accept(fd, addr, len) as Promise<number>,
    };
    return _asyncAcceptLib;
}

async function rawAcceptAsync(listenFd: number): Promise<number> {
    const lib = getAsyncAcceptLib();
    const fd = await lib.accept(listenFd, null, null);
    if (fd < 0) throw new Error(`accept() failed (async): fd=${fd}`);
    return fd;
}

// ─── Sync/async read ───

function rawReadFd(fd: number, buf: Uint8Array<ArrayBuffer>): number {
    const libc = getLibC();
    const n = Number(libc.read(fd, Deno.UnsafePointer.of(buf), buf.length));
    if (n < 0) throw new Error(`read() failed: ${errnoMessage()}`);
    return n;
}

let _asyncReadLib: { read: (fd: number, buf: PointerValue, count: number) => Promise<number> } | null = null;
let _asyncRecvmsgLib: { recvmsg: (fd: number, msghdr: PointerValue, flags: number) => Promise<number> } | null = null;

function getAsyncRecvmsgLib() {
    if (_asyncRecvmsgLib) return _asyncRecvmsgLib;
    const lib = Deno.dlopen(LIBC_PATH, {
        recvmsg: { parameters: ["i32", "pointer", "i32"], result: "isize", nonblocking: true },
    });
    _asyncRecvmsgLib = {
        recvmsg: (fd, msghdr, flags) => lib.symbols.recvmsg(fd, msghdr, flags) as Promise<number>,
    };
    return _asyncRecvmsgLib;
}

function getAsyncReadLib() {
    if (_asyncReadLib) return _asyncReadLib;
    const lib = Deno.dlopen(LIBC_PATH, {
        read: { parameters: ["i32", "pointer", "usize"], result: "isize", nonblocking: true },
    });
    _asyncReadLib = {
        read: (fd, buf, count) => lib.symbols.read(fd, buf, count) as Promise<number>,
    };
    return _asyncReadLib;
}

async function rawReadFdAsync(fd: number, buf: Uint8Array<ArrayBuffer>): Promise<number> {
    const lib = getAsyncReadLib();
    const n = await lib.read(fd, Deno.UnsafePointer.of(buf)!, buf.length);
    return Number(n);
}

// ─── Write ───

function rawWriteFd(fd: number, data: Uint8Array): void {
    const libc = getLibC();
    const buf = (data.buffer instanceof ArrayBuffer)
        ? data as Uint8Array<ArrayBuffer>
        : new Uint8Array(data) as Uint8Array<ArrayBuffer>;
    let written = 0;
    while (written < data.length) {
        const n = Number(libc.write(fd, Deno.UnsafePointer.of(buf.subarray(written) as Uint8Array<ArrayBuffer>), data.length - written));
        if (n < 0) throw new Error(`write() failed: ${errnoMessage()}`);
        written += n;
    }
}

// ─── sendmsg / recvmsg ───

function rawSendFds(sockFd: number, fds: number[], data: Uint8Array): void {
    if (data.byteLength === 0) {
        throw new Error("Cannot send FDs with a zero-length payload");
    }
    const libc = getLibC();

    const fdCount = fds.length;
    const cmsgDataLen = fdCount * 4;
    const cmsgLen = CMSG_DATA_OFFSET + cmsgDataLen;
    const cmsgSpace = Math.ceil(cmsgLen / CMSG_ALIGN) * CMSG_ALIGN;

    const controlBuf = new ArrayBuffer(cmsgSpace);
    const controlView = new DataView(controlBuf);
    const controlArr = new Uint8Array(controlBuf) as Uint8Array<ArrayBuffer>;

    if (IS_DARWIN) {
        controlView.setUint32(0, cmsgLen, true);
    } else {
        controlView.setBigUint64(0, BigInt(cmsgLen), true);
    }
    controlView.setInt32(CMSG_LEVEL_OFFSET, SOL_SOCKET, true);
    controlView.setInt32(CMSG_TYPE_OFFSET, SCM_RIGHTS, true);

    for (let i = 0; i < fdCount; i++) {
        controlView.setInt32(CMSG_DATA_OFFSET + i * 4, fds[i], true);
    }

    const dataBuf = new Uint8Array(data.buffer, data.byteOffset, data.byteLength) as Uint8Array<ArrayBuffer>;
    const iovecBuf = new ArrayBuffer(IOVEC_SIZE);
    const iovecView = new DataView(iovecBuf);
    const iovecArr = new Uint8Array(iovecBuf) as Uint8Array<ArrayBuffer>;

    const dataPtr = Deno.UnsafePointer.of(dataBuf);
    iovecView.setBigUint64(0, BigInt(Deno.UnsafePointer.value(dataPtr!)), true);
    iovecView.setBigUint64(8, BigInt(dataBuf.byteLength), true);

    const msghdrBuf = new ArrayBuffer(MSGHDR_SIZE);
    const msghdrView = new DataView(msghdrBuf);
    const msghdrArr = new Uint8Array(msghdrBuf) as Uint8Array<ArrayBuffer>;

    const iovecPtr = Deno.UnsafePointer.of(iovecArr);
    const controlPtr = Deno.UnsafePointer.of(controlArr);

    msghdrView.setBigUint64(MSGHDR_IOV_OFFSET, BigInt(Deno.UnsafePointer.value(iovecPtr!)), true);
    if (IS_DARWIN) {
        msghdrView.setInt32(MSGHDR_IOVLEN_OFFSET, 1, true);
    } else {
        msghdrView.setBigUint64(MSGHDR_IOVLEN_OFFSET, 1n, true);
    }
    msghdrView.setBigUint64(MSGHDR_CONTROL_OFFSET, BigInt(Deno.UnsafePointer.value(controlPtr!)), true);
    if (IS_DARWIN) {
        msghdrView.setUint32(MSGHDR_CONTROLLEN_OFFSET, cmsgSpace, true);
    } else {
        msghdrView.setBigUint64(MSGHDR_CONTROLLEN_OFFSET, BigInt(cmsgSpace), true);
    }

    const msghdrPtr = Deno.UnsafePointer.of(msghdrArr);
    const result = Number(libc.sendmsg(sockFd, msghdrPtr, 0));
    if (result < 0) throw new Error(`sendmsg() failed: ${errnoMessage()}`);

    if (result < data.byteLength) {
        rawWriteFd(sockFd, data.subarray(result));
    }
}

function rawRecvFdsAndData(sockFd: number, maxFds: number, maxDataLen: number = 8192): { data: Uint8Array; fds: number[] } {
    const libc = getLibC();

    const cmsgDataLen = maxFds * 4;
    const cmsgSpace = Math.ceil((CMSG_DATA_OFFSET + cmsgDataLen) / CMSG_ALIGN) * CMSG_ALIGN;

    const controlBuf = new ArrayBuffer(cmsgSpace);
    const controlView = new DataView(controlBuf);
    const controlArr = new Uint8Array(controlBuf) as Uint8Array<ArrayBuffer>;

    const dataBuf = new Uint8Array(maxDataLen) as Uint8Array<ArrayBuffer>;
    const iovecBuf = new ArrayBuffer(IOVEC_SIZE);
    const iovecView = new DataView(iovecBuf);
    const iovecArr = new Uint8Array(iovecBuf) as Uint8Array<ArrayBuffer>;

    const dataPtr = Deno.UnsafePointer.of(dataBuf);
    iovecView.setBigUint64(0, BigInt(Deno.UnsafePointer.value(dataPtr!)), true);
    iovecView.setBigUint64(8, BigInt(maxDataLen), true);

    const msghdrBuf = new ArrayBuffer(MSGHDR_SIZE);
    const msghdrView = new DataView(msghdrBuf);
    const msghdrArr = new Uint8Array(msghdrBuf) as Uint8Array<ArrayBuffer>;

    const iovecPtr = Deno.UnsafePointer.of(iovecArr);
    const controlPtr = Deno.UnsafePointer.of(controlArr);

    msghdrView.setBigUint64(MSGHDR_IOV_OFFSET, BigInt(Deno.UnsafePointer.value(iovecPtr!)), true);
    if (IS_DARWIN) {
        msghdrView.setInt32(MSGHDR_IOVLEN_OFFSET, 1, true);
    } else {
        msghdrView.setBigUint64(MSGHDR_IOVLEN_OFFSET, 1n, true);
    }
    msghdrView.setBigUint64(MSGHDR_CONTROL_OFFSET, BigInt(Deno.UnsafePointer.value(controlPtr!)), true);
    if (IS_DARWIN) {
        msghdrView.setUint32(MSGHDR_CONTROLLEN_OFFSET, cmsgSpace, true);
    } else {
        msghdrView.setBigUint64(MSGHDR_CONTROLLEN_OFFSET, BigInt(cmsgSpace), true);
    }

    const msghdrPtr = Deno.UnsafePointer.of(msghdrArr);
    const result = Number(libc.recvmsg(sockFd, msghdrPtr, 0));
    if (result < 0) throw new Error(`recvmsg() failed: ${errnoMessage()}`);

    const msg_flags = msghdrView.getInt32(MSGHDR_FLAGS_OFFSET, true);
    if ((msg_flags & MSG_CTRUNC) !== 0) {
        throw new Error("recvmsg() failed: MSG_CTRUNC (control message truncated, too many FDs)");
    }

    const data = dataBuf.subarray(0, result);

    let cmsgLen: number;
    if (IS_DARWIN) {
        cmsgLen = controlView.getUint32(0, true);
    } else {
        cmsgLen = Number(controlView.getBigUint64(0, true));
    }

    const fdBytes = cmsgLen - CMSG_DATA_OFFSET;
    const fdCount = Math.floor(fdBytes / 4);

    const fds: number[] = [];
    if (fdCount > 0 && cmsgLen >= CMSG_DATA_OFFSET) {
        const cmsgLevel = controlView.getInt32(CMSG_LEVEL_OFFSET, true);
        const cmsgType = controlView.getInt32(CMSG_TYPE_OFFSET, true);
        if (cmsgLevel === SOL_SOCKET && cmsgType === SCM_RIGHTS) {
            for (let i = 0; i < fdCount; i++) {
                fds.push(controlView.getInt32(CMSG_DATA_OFFSET + i * 4, true));
            }
        }
    }

    return { data, fds };
}

async function rawRecvFdsAndDataAsync(sockFd: number, maxFds: number, maxDataLen: number = 8192): Promise<{ data: Uint8Array; fds: number[] }> {
    const lib = getAsyncRecvmsgLib();
    
    const cmsgDataLen = maxFds * 4;
    const cmsgLen = CMSG_DATA_OFFSET + cmsgDataLen;
    const cmsgSpace = Math.ceil(cmsgLen / CMSG_ALIGN) * CMSG_ALIGN;

    const controlBuf = new ArrayBuffer(cmsgSpace);
    const controlView = new DataView(controlBuf);
    const controlArr = new Uint8Array(controlBuf) as Uint8Array<ArrayBuffer>;

    const dataBuf = new Uint8Array(maxDataLen) as Uint8Array<ArrayBuffer>;
    const iovecBuf = new ArrayBuffer(IOVEC_SIZE);
    const iovecView = new DataView(iovecBuf);
    const iovecArr = new Uint8Array(iovecBuf) as Uint8Array<ArrayBuffer>;

    const dataPtr = Deno.UnsafePointer.of(dataBuf);
    iovecView.setBigUint64(0, BigInt(Deno.UnsafePointer.value(dataPtr!)), true);
    iovecView.setBigUint64(8, BigInt(maxDataLen), true);

    const msghdrBuf = new ArrayBuffer(MSGHDR_SIZE);
    const msghdrView = new DataView(msghdrBuf);
    const msghdrArr = new Uint8Array(msghdrBuf) as Uint8Array<ArrayBuffer>;

    const iovecPtr = Deno.UnsafePointer.of(iovecArr);
    const controlPtr = Deno.UnsafePointer.of(controlArr);

    msghdrView.setBigUint64(MSGHDR_IOV_OFFSET, BigInt(Deno.UnsafePointer.value(iovecPtr!)), true);
    if (IS_DARWIN) {
        msghdrView.setInt32(MSGHDR_IOVLEN_OFFSET, 1, true);
    } else {
        msghdrView.setBigUint64(MSGHDR_IOVLEN_OFFSET, 1n, true);
    }
    msghdrView.setBigUint64(MSGHDR_CONTROL_OFFSET, BigInt(Deno.UnsafePointer.value(controlPtr!)), true);
    if (IS_DARWIN) {
        msghdrView.setUint32(MSGHDR_CONTROLLEN_OFFSET, cmsgSpace, true);
    } else {
        msghdrView.setBigUint64(MSGHDR_CONTROLLEN_OFFSET, BigInt(cmsgSpace), true);
    }

    const msghdrPtr = Deno.UnsafePointer.of(msghdrArr);
    const result = Number(await lib.recvmsg(sockFd, msghdrPtr, 0));
    if (result <= 0) return { data: new Uint8Array(0), fds: [] };

    const msg_flags = msghdrView.getInt32(MSGHDR_FLAGS_OFFSET, true);
    if ((msg_flags & MSG_CTRUNC) !== 0) {
        throw new Error("recvmsg() failed: MSG_CTRUNC (control message truncated, too many FDs)");
    }

    const data = dataBuf.subarray(0, result);

    let recvCmsgLen: number;
    if (IS_DARWIN) {
        recvCmsgLen = controlView.getUint32(0, true);
    } else {
        recvCmsgLen = Number(controlView.getBigUint64(0, true));
    }

    const fdBytes = recvCmsgLen - CMSG_DATA_OFFSET;
    const fdCount = Math.floor(fdBytes / 4);

    const fds: number[] = [];
    if (fdCount > 0 && recvCmsgLen >= CMSG_DATA_OFFSET) {
        const cmsgLevel = controlView.getInt32(CMSG_LEVEL_OFFSET, true);
        const cmsgType = controlView.getInt32(CMSG_TYPE_OFFSET, true);
        if (cmsgLevel === SOL_SOCKET && cmsgType === SCM_RIGHTS) {
            for (let i = 0; i < fdCount; i++) {
                fds.push(controlView.getInt32(CMSG_DATA_OFFSET + i * 4, true));
            }
        }
    }

    return { data, fds };
}

// ─── Stream wrappers ───

function fdToReadable(fd: number): ReadableStream<Uint8Array> {
    const buf = new Uint8Array(16384) as Uint8Array<ArrayBuffer>;
    let closed = false;

    const stream = new ReadableStream({
        async pull(controller) {
            if (closed) return;
            try {
                const n = await rawReadFdAsync(fd, buf);
                if (n > 0) {
                    controller.enqueue(buf.slice(0, n));
                } else {
                    closed = true;
                    controller.close();
                    rawClose(fd);
                }
            } catch {
                if (!closed) {
                    closed = true;
                    controller.close();
                    rawClose(fd);
                }
            }
        },
        cancel() {
            if (!closed) { closed = true; rawClose(fd); }
        },
    }, { highWaterMark: 0 });
    attachFd(stream, fd);
    return stream;
}

function fdToWritable(fd: number): WritableStream<Uint8Array> {
    const stream = new WritableStream({
        write(chunk) {
            rawWriteFd(fd, chunk);
        },
        close() {
            rawClose(fd);
        },
        abort() {
            rawClose(fd);
        },
    });
    attachFd(stream, fd);
    return stream;
}

/** Create an inert handle for a transferred FD. Lazy — the FD is untouched
 *  until the receiver creates a stream via .readable or .writable.
 *  getFd() works directly on the handle for low-level use (e.g. posix_spawn). */
function makeTransferHandle(fd: number): TransferHandle {
    let _readable: ReadableStream<Uint8Array> | undefined;
    let _writable: WritableStream<Uint8Array> | undefined;
    let closed = false;
    const handle: TransferHandle = {
        get readable() { return _readable ??= fdToReadable(fd); },
        get writable() { return _writable ??= fdToWritable(fd); },
        close() { if (!closed) { closed = true; rawClose(fd); } },
    };
    attachFd(handle as any, fd);
    return handle;
}

// ─── Connection ───

function makeConnection(connFd: number): Connection {
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((res) => { resolveClosed = res; });
    let isClosed = false;

    return {
        send(data: Uint8Array, transfer?: (ReadableStream<Uint8Array> | WritableStream<Uint8Array>)[]): void {
            if (isClosed) throw new ConnectionClosed();
            try {
                if (transfer && transfer.length > 0) {
                    const fds = transfer.map(getFd);
                    try {
                        rawSendFds(connFd, fds, data);
                    } finally {
                        for (const fd of fds) rawClose(fd);
                    }
                } else {
                    rawWriteFd(connFd, data);
                }
            } catch {
                isClosed = true;
                resolveClosed();
                throw new ConnectionClosed();
            }
        },

        receive(): { data: Uint8Array; transferred: TransferHandle[] } {
            const { data, fds } = rawRecvFdsAndData(connFd, 4);
            const transferred = fds.map(makeTransferHandle);
            return { data, transferred };
        },

        async receiveAsync(): Promise<{ data: Uint8Array; transferred: TransferHandle[] }> {
            const { data, fds } = await rawRecvFdsAndDataAsync(connFd, 4);
            const transferred = fds.map(makeTransferHandle);
            return { data, transferred };
        },

        get closed() { return closedPromise; },

        close(): void {
            if (!isClosed) {
                isClosed = true;
                rawClose(connFd);
                resolveClosed();
            }
        },
    };
}

// ─── Listener ───

function makeListener(listenFd: number, socketPath: string): Listener {
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((res) => { resolveClosed = res; });
    let isClosed = false;

    return {
        async accept(): Promise<Connection> {
            const connFd = await rawAcceptAsync(listenFd);
            return makeConnection(connFd);
        },

        get closed() { return closedPromise; },

        close(): void {
            if (!isClosed) {
                isClosed = true;
                rawClose(listenFd);
                try {
                    const pathBuf = new TextEncoder().encode(socketPath + "\0");
                    const pathArr = new Uint8Array(pathBuf.buffer) as Uint8Array<ArrayBuffer>;
                    getLibC().unlink(Deno.UnsafePointer.of(pathArr));
                } catch { /* best effort */ }
                resolveClosed();
            }
        },
    };
}

// ─── Pipe ───

function makePipe(): Pipe {
    const [readFd, writeFd] = rawPipe();
    const readable = fdToReadable(readFd);
    const writable = fdToWritable(writeFd);
    return { readable, writable };
}

// ─── Public API ───

return {
    connect(path: string): Connection {
        const connFd = rawConnectUnix(path);
        return makeConnection(connFd);
    },
    listen(path: string): Listener {
        const listenFd = rawListenUnix(path);
        return makeListener(listenFd, path);
    },
    pipe(): Pipe {
        return makePipe();
    },
};

} // makeFdlink
