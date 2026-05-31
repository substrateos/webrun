/**
 * fdlink/rpc — comlink-style RPC over Connection.
 *
 * Wire: JSON lines. { id, t:"get"|"apply", p?, k, a? } → { id, r?, e?, proxy? }
 * SCM_RIGHTS FDs travel with the first sendmsg.
 */

import type { Connection, TransferHandle } from "./types.ts";
import { ConnectionClosed } from "./types.ts";

const PROXY = Symbol("fdlink.proxy");
const XFER = Symbol("fdlink.transfer");

type Stream = ReadableStream<Uint8Array> | WritableStream<Uint8Array>;

/** Mark a return value for proxying (caller gets a remote handle). */
export function proxy<T extends object>(obj: T): T {
    Object.defineProperty(obj, PROXY, { value: true });
    return obj;
}

/** Mark streams for SCM_RIGHTS transfer alongside an RPC call. */
export function transfer(streams: Stream[]): Stream[] {
    return Object.assign(streams, { [XFER]: true });
}

export enum RpcAction {
    Get = "get",
    Apply = "apply",
    Release = "release"
}

export interface ObjectStream {
    send(msg: unknown, transfers?: Stream[]): void;
    receive(syncFirst?: boolean): AsyncGenerator<{ msg: any; transfers: TransferHandle[] }>;
    close(): void;
}

// ── Codec ────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

export class JSONStream implements ObjectStream {
    private conn: Connection;
    private buf = "";

    constructor(conn: Connection) { this.conn = conn; }

    send(msg: unknown, transfers?: Stream[]): void {
        this.conn.send(enc.encode(JSON.stringify(msg) + "\n"), transfers);
    }

    async *receive(syncFirst = false): AsyncGenerator<{ msg: any; transfers: TransferHandle[] }> {
        if (syncFirst) {
            const first = this.conn.receive();
            yield* this.drain(dec.decode(first.data), first.transferred);
        }
        for (;;) {
            const { data } = await this.conn.receiveAsync();
            if (!data.length) break;
            yield* this.drain(dec.decode(data), []);
        }
    }

    private *drain(text: string, transfers: TransferHandle[]) {
        this.buf += text;
        let i;
        while ((i = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.substring(0, i);
            this.buf = this.buf.substring(i + 1);
            if (line) yield { msg: JSON.parse(line), transfers };
            transfers = [];
        }
    }

    close() { this.conn.close(); }
}

// ── Server ───────────────────────────────────────────────────────────────────

/** Serve `impl`'s methods over `ch`. */
export function expose(impl: Record<string, any>, ch: ObjectStream): void {
    const proxies = new Map<number, any>();
    let nextProxy = 1;

    async function dispatch({ id, t, p, k, a }: any, transfers: TransferHandle[]) {
        if (t === RpcAction.Release) {
            if (p != null) proxies.delete(p);
            ch.send({ id, r: null });
            return;
        }
        
        const target = p != null ? proxies.get(p) : impl;
        if (!target) { ch.send({ id, e: `Unknown proxy: ${p}` }); return; }
        if (typeof k !== "string" || !Object.hasOwn(target, k)) {
            ch.send({ id, e: `Invalid or unauthorized method: ${String(k)}` });
            return;
        }
        try {
            let val = t === RpcAction.Apply
                ? target[k].apply(target, transfers.length ? [...(a || []), transfers] : (a || []))
                : target[k];
            if (val instanceof Promise) val = await val;
            if (val?.[PROXY]) {
                const pid = nextProxy++;
                proxies.set(pid, val);
                ch.send({ id, r: pid, proxy: true });
            } else {
                ch.send({ id, r: val ?? null });
            }
        } catch (e) {
            if (e instanceof ConnectionClosed) return;
            ch.send({ id, e: String(e) });
        }
    }

    (async () => {
        try {
            for await (const { msg, transfers } of ch.receive(true)) {
                dispatch(msg, transfers);
            }
        } catch (e) {
            if (!(e instanceof ConnectionClosed)) throw e;
        }
    })();
}

// ── Client ───────────────────────────────────────────────────────────────────

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** Get a typed proxy that calls methods on the remote over `ch`. */
export function wrap<T>(ch: ObjectStream): T {
    const pending = new Map<number, Pending>();
    let nextId = 1;

    (async () => {
        try {
            for await (const { msg } of ch.receive()) {
                const p = pending.get(msg.id);
                if (p) { pending.delete(msg.id); msg.e ? p.reject(new Error(msg.e)) : p.resolve(msg); }
            }
        } catch (e) {
            if (!(e instanceof ConnectionClosed)) throw e;
        }
        for (const p of pending.values()) p.reject(new ConnectionClosed());
    })();

    function request(t: RpcAction, p: number | undefined, k: string, a?: unknown[], xfer?: Stream[]) {
        const id = nextId++;
        return new Promise<any>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            ch.send({ id, t, p, k, a }, xfer);
        });
    }

    function unwrap(msg: any) { return msg.proxy ? makeProxy(msg.r) : msg.r; }

    function makeProxy(target?: number): any {
        return new Proxy(function () {}, {
            get(_, k: string | symbol) {
                if (k === "then") return undefined;
                if (k === Symbol.asyncDispose) {
                    return () => request(RpcAction.Release, target, "");
                }
                return new Proxy(function () {}, {
                    apply(_, __, args) {
                        let xfer: Stream[] | undefined;
                        const clean = args.filter((a: any) => { if (a?.[XFER]) { xfer = a; return false; } return true; });
                        return request(RpcAction.Apply, target, k as string, clean, xfer).then(unwrap);
                    },
                    get(_, prop) {
                        if (prop === "then") {
                            const p = request(RpcAction.Get, target, k as string).then(unwrap);
                            return p.then.bind(p);
                        }
                    },
                });
            },
        });
    }

    return makeProxy() as T;
}
