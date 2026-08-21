/**
 * IPC transport for the sandbox↔worker boundary.
 *
 * Uses Comlink over postMessage for RPC.
 * Comlink is strictly confined to this module — no other module imports it.
 */
import * as Comlink from "npm:comlink@4.4.2";
import type { ContextDescriptor, WorkerAPI, WorkerContext, WorkerStdio } from "../core/ipc.ts";
import type { RunOptions } from "../core/types.ts";

// ReadableStream/WritableStream are transferable at runtime but TS doesn't declare them so.
type StreamTransferable = ReadableStream | WritableStream;
const asTransferable = (streams: (StreamTransferable | null)[]): Transferable[] =>
    streams.filter((s): s is StreamTransferable => s != null) as unknown as Transferable[];

interface WireRunHandle {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    urls: string[];
    _port: MessagePort;
}

interface WireWorkerContext extends Omit<WorkerContext, "run"> {
    run(args: string[], options?: RunOptions): Promise<WireRunHandle>;
}

interface WireWorkerAPI {
    init(descriptor: ContextDescriptor, stdio: WorkerStdio, ctx: WireWorkerContext, ports?: Record<string, MessagePort>): Promise<void>;
}

/**
 * Worker side: expose the WorkerAPI on self.
 *
 * Wraps the provided API so that the `sandboxAPI` received via Comlink
 * has its function-accepting methods (`onAbort`) transparently
 * proxied, and `run()` return values are reassembled from the wire format
 * (streams transferred, exitCode/signal proxied via MessagePort).
 *
 * This keeps Comlink concerns out of the worker implementation.
 */
export function exposeSelf(api: WorkerAPI): void {
    const wrapped: WireWorkerAPI = {
        async init(descriptor, stdio, sandboxAPI, ports) {
            // Await tty since sandboxAPI is a Comlink proxy — property access returns a Promise.
            const tty = await sandboxAPI.tty;
            const proxied: WorkerContext = {
                exit: sandboxAPI.exit,
                tty,
                onAbort: (cb) => sandboxAPI.onAbort(Comlink.proxy(cb)),
                async run(args, options) {
                    // The sandbox decomposes RunHandle into a wire format:
                    //   { stdout, stderr, methods } where methods proxies exitCode + signal.
                    const opts = options?.stdin
                        ? Comlink.transfer({ ...options }, asTransferable([options.stdin]))
                        : options;
                    const wire = await sandboxAPI.run(args, opts);
                    const proxy = Comlink.wrap<{ getExitCode(): Promise<number>; signal(sig: string): void }>(wire._port);
                    return {
                        stdout: wire.stdout,
                        stderr: wire.stderr,
                        exitCode: proxy.getExitCode(),
                        signal: (sig: string) => proxy.signal(sig),
                        urls: Promise.resolve((wire.urls || []).map((u: string) => new URL(u))),
                    };
                },
            };
            return api.init(descriptor, stdio, proxied, ports);
        },
    };
    Comlink.expose(wrapped, globalThis as unknown as Worker);
}

/**
 * Sandbox side: connect to a Worker and get its WorkerAPI.
 *
 * Returns a wrapped API where:
 *  - init() transfers stdio streams and proxies the WorkerContext
 *  - The WorkerContext.run() return value is decomposed for the wire:
 *    streams are transferred, exitCode/signal are proxied via MessagePort
 */
export function connectWorker(worker: Worker, sandboxAPI: WorkerContext): WorkerAPI {
    const raw: WireWorkerAPI = Comlink.wrap(worker);

    // Wrap the context so Comlink can proxy functions and transfer streams.
    const proxiedCtx: WireWorkerContext = {
        exit: sandboxAPI.exit,
        onAbort: sandboxAPI.onAbort,
        tty: sandboxAPI.tty,
        async run(args, options) {
            const opts = options?.stdin
                ? Comlink.transfer({ ...options }, asTransferable([options.stdin]))
                : options;
            const handle = await sandboxAPI.run(args, opts);

            // Decompose: proxy non-cloneable parts,
            // transfer streams directly.
            const urls = await handle.urls;

            const { port1, port2 } = new MessageChannel();
            Comlink.expose({
                getExitCode: () => handle.exitCode,
                signal: handle.signal.bind(handle),
            }, port1);

            return Comlink.transfer(
                {
                    stdout: handle.stdout,
                    stderr: handle.stderr,
                    urls: (urls || []).map(u => u.href),
                    _port: port2,
                },
                [...asTransferable([handle.stdout, handle.stderr]), port2],
            );
        },
    };

    return {
        init(descriptor, stdio, ports) {
            return raw.init(
                descriptor,
                Comlink.transfer(stdio, asTransferable([stdio.stdin, stdio.stdout, stdio.stderr])),
                Comlink.proxy(proxiedCtx),
                ports ? Comlink.transfer(ports, Object.values(ports)) : undefined,
            );
        },
    };
}

