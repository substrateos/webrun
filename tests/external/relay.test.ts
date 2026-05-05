// relay.test.ts — Tests for the TCP relay used in the MITM import proxy.
//
// Verifies that large payloads are relayed without corruption or stalls,
// even under concurrent load (simulating multiple parallel downloads).
//
// Runner: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/relay.test.ts

import { registerTests, sys } from "./_adapter.ts";
import { relay } from "../../src/import_proxy.ts";
import * as net from "node:net";
import { Buffer } from "node:buffer";

/**
 * Relay a payload through a source→relay→sink TCP pipeline.
 * Returns the received bytes for integrity checking.
 */
async function relayPayload(payload: Uint8Array): Promise<Buffer> {
    const sourceListener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
    const sourcePort = (sourceListener.addr as Deno.NetAddr).port;

    const sinkServer = net.createServer();
    sinkServer.listen(0, "127.0.0.1");
    await new Promise<void>(r => sinkServer.on("listening", r));
    const sinkPort = (sinkServer.address() as net.AddressInfo).port;

    const receivedChunks: Buffer[] = [];
    const sinkDone = new Promise<Buffer>(resolve => {
        sinkServer.on("connection", (socket: net.Socket) => {
            socket.on("data", (chunk: Buffer) => receivedChunks.push(Buffer.from(chunk)));
            socket.on("end", () => resolve(Buffer.concat(receivedChunks)));
        });
    });

    const denoConn = await Deno.connect({ hostname: "127.0.0.1", port: sourcePort });
    const sourceConn = await sourceListener.accept();
    const sinkSocket = net.createConnection({ host: "127.0.0.1", port: sinkPort });
    await new Promise<void>(r => sinkSocket.on("connect", r));

    relay(sourceConn, sinkSocket);

    // Write in 16KiB chunks (matching relay buffer size).
    let offset = 0;
    while (offset < payload.length) {
        const end = Math.min(offset + 16384, payload.length);
        const written = await denoConn.write(payload.subarray(offset, end));
        offset += written;
    }
    denoConn.close();

    const received = await Promise.race([
        sinkDone,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(
                `Relay stalled: received ${receivedChunks.reduce((a, b) => a + b.length, 0)}/${payload.length} bytes`
            )), 10000)
        ),
    ]);

    sinkServer.close();
    sourceListener.close();
    return received;
}

function verifyPayload(received: Buffer, expected: Uint8Array, label: string): void {
    if (received.length !== expected.length) {
        throw new Error(`[${label}] Expected ${expected.length} bytes, received ${received.length}`);
    }
    for (let i = 0; i < expected.length; i++) {
        if (received[i] !== expected[i]) {
            throw new Error(`[${label}] Byte mismatch at offset ${i}: expected ${expected[i]}, got ${received[i]}`);
        }
    }
}

export async function testProxyRelay(t: any) {
    await t.run("relay delivers 256KiB payload without corruption", async () => {
        const payloadSize = 256 * 1024;
        const payload = new Uint8Array(payloadSize);
        for (let i = 0; i < payloadSize; i++) payload[i] = i & 0xff;

        const received = await relayPayload(payload);
        verifyPayload(received, payload, "single");
    });

    await t.run("10 concurrent 256KiB relays deliver without corruption", async () => {
        const concurrency = 10;
        const payloadSize = 256 * 1024;

        // Each relay gets a distinct payload (different starting byte).
        const payloads: Uint8Array[] = [];
        for (let c = 0; c < concurrency; c++) {
            const p = new Uint8Array(payloadSize);
            for (let i = 0; i < payloadSize; i++) p[i] = (i + c) & 0xff;
            payloads.push(p);
        }

        // Launch all relays concurrently.
        const results = await Promise.all(
            payloads.map(p => relayPayload(p))
        );

        for (let c = 0; c < concurrency; c++) {
            verifyPayload(results[c], payloads[c], `relay-${c}`);
        }
    });
}

import * as self from "./relay.test.ts";
registerTests(self);
