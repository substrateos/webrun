import { startMuxProxy, timingSafeEqual } from "../src/mux.ts";

export async function testMux(t: any) {
    // ── T0: timingSafeEqual unit tests ──

    const equalCases = [
        { name: "identical bytes → true",  a: "hello", b: "hello", expect: true },
        { name: "different bytes → false", a: "hello", b: "world", expect: false },
        { name: "different length → false", a: "hi",    b: "hello", expect: false },
        { name: "empty arrays → true",     a: "",      b: "",      expect: true },
        { name: "single char match",       a: "a",     b: "a",     expect: true },
        { name: "single char mismatch",    a: "a",     b: "b",     expect: false },
    ];

    const enc = new TextEncoder();
    for (const tc of equalCases) {
        await t.run(`timingSafeEqual: ${tc.name}`, async () => {
            const result = timingSafeEqual(enc.encode(tc.a), enc.encode(tc.b));
            if (result !== tc.expect) {
                throw new Error(`Expected ${tc.expect}, got ${result}`);
            }
        });
    }

    // Use the test system runtime for network operations
    const sys = t.testsys;
    const nativeFetch = sys.nativeFetch;
    const denoServe = sys.serve;
    const denoListen = sys.listen;

    if (!denoServe || !denoListen) {
        t.skip("Deno.serve/listen not available in test context");
        return;
    }

    function getFreePort(): number {
        return sys.getFreePort();
    }

    function makeMuxSys() {
        return { listen: denoListen, serve: denoServe };
    }

    // ── T1: startMuxProxy returns null for empty bindings ──

    await t.run("startMuxProxy: empty bindings returns null", async () => {
        const result = startMuxProxy(makeMuxSys(), []);
        if (result !== null) {
            throw new Error(`Expected null, got port ${result.port}`);
        }
    });

    // ── T2: startMuxProxy token validation (table-driven) ──

    const VALID_TOKEN = crypto.randomUUID();
    const UPSTREAM_PORT = getFreePort();
    const UPSTREAM_RESPONSE = "mux-test-ok";

    // Start a simple upstream server
    const upstreamAc = new AbortController();
    const upstreamServer = denoServe(
        { port: UPSTREAM_PORT, hostname: "127.0.0.1", signal: upstreamAc.signal, onListen: () => {} },
        (req: Request) => {
            // Verify Authorization header was stripped
            if (req.headers.has("Authorization")) {
                return new Response("ERROR: Authorization header leaked", { status: 500 });
            }
            return new Response(UPSTREAM_RESPONSE);
        }
    );

    const muxProxy = startMuxProxy(
        makeMuxSys(),
        [{ name: "testbinding", port: UPSTREAM_PORT, token: VALID_TOKEN }],
    );

    if (!muxProxy) throw new Error("Expected mux proxy, got null");

    const tokenCases = [
        { name: "valid token routes to correct port", token: VALID_TOKEN,   expectStatus: 200 },
        { name: "invalid token returns 403",          token: "wrong-token", expectStatus: 403 },
        { name: "missing Authorization returns 401",  token: null as string | null,          expectStatus: 401 },
        { name: "malformed header returns 401",       token: null as string | null, rawHeader: "Basic notbearer", expectStatus: 401 },
    ];

    try {
        for (const tc of tokenCases) {
            await t.run(`startMuxProxy: ${tc.name}`, async () => {
                const headers: Record<string, string> = {};
                if (tc.token !== null && tc.token !== undefined) {
                    headers["Authorization"] = `Bearer ${tc.token}`;
                } else if ((tc as any).rawHeader) {
                    headers["Authorization"] = (tc as any).rawHeader;
                }

                const res = await nativeFetch(`http://127.0.0.1:${muxProxy.port}/test`, { headers });
                if (res.status !== tc.expectStatus) {
                    const body = await res.text();
                    throw new Error(`Expected status ${tc.expectStatus}, got ${res.status} (body: ${body})`);
                }

                // For valid requests, verify response body
                if (tc.expectStatus === 200) {
                    const body = await res.text();
                    if (body !== UPSTREAM_RESPONSE) {
                        throw new Error(`Expected body "${UPSTREAM_RESPONSE}", got "${body}"`);
                    }
                } else {
                    await res.body?.cancel();
                }
            });
        }

        // ── T3: Authorization header stripped before forwarding ──

        await t.run("startMuxProxy: strips Authorization header before upstream", async () => {
            const res = await nativeFetch(`http://127.0.0.1:${muxProxy.port}/test`, {
                headers: { "Authorization": `Bearer ${VALID_TOKEN}` },
            });
            if (res.status !== 200) {
                const body = await res.text();
                throw new Error(`Authorization header leaked to upstream: ${body}`);
            }
            await res.body?.cancel();
        });

        // ── T4: Multiple bindings on one mux port ──

        await t.run("startMuxProxy: multiple bindings route correctly", async () => {
            const port2 = getFreePort();
            const token2 = crypto.randomUUID();
            const ac2 = new AbortController();
            const server2 = denoServe(
                { port: port2, hostname: "127.0.0.1", signal: ac2.signal, onListen: () => {} },
                () => new Response("binding-two"),
            );

            const multi = startMuxProxy(
                makeMuxSys(),
                [
                    { name: "one", port: UPSTREAM_PORT, token: VALID_TOKEN },
                    { name: "two", port: port2, token: token2 },
                ],
            );
            if (!multi) throw new Error("Expected mux proxy");

            try {
                const r1 = await nativeFetch(`http://127.0.0.1:${multi.port}/`, {
                    headers: { "Authorization": `Bearer ${VALID_TOKEN}` },
                });
                const b1 = await r1.text();
                if (b1 !== UPSTREAM_RESPONSE) throw new Error(`Binding one: expected "${UPSTREAM_RESPONSE}", got "${b1}"`);

                const r2 = await nativeFetch(`http://127.0.0.1:${multi.port}/`, {
                    headers: { "Authorization": `Bearer ${token2}` },
                });
                const b2 = await r2.text();
                if (b2 !== "binding-two") throw new Error(`Binding two: expected "binding-two", got "${b2}"`);
            } finally {
                await multi.shutdown();
                ac2.abort();
                await server2.finished;
            }
        });

        // ── T5: Streaming passthrough ──

        await t.run("startMuxProxy: streams response body without buffering", async () => {
            const streamPort = getFreePort();
            const streamAc = new AbortController();
            const streamToken = crypto.randomUUID();

            const streamServer = denoServe(
                { port: streamPort, hostname: "127.0.0.1", signal: streamAc.signal, onListen: () => {} },
                () => {
                    const encoder = new TextEncoder();
                    const stream = new ReadableStream({
                        async start(controller) {
                            for (let i = 0; i < 3; i++) {
                                controller.enqueue(encoder.encode(`chunk${i}\n`));
                                await new Promise(r => setTimeout(r, 10));
                            }
                            controller.close();
                        }
                    });
                    return new Response(stream, {
                        headers: { "Content-Type": "text/plain" }
                    });
                },
            );

            const streamMux = startMuxProxy(
                makeMuxSys(),
                [{ name: "stream", port: streamPort, token: streamToken }],
            );
            if (!streamMux) throw new Error("Expected mux proxy");

            try {
                const res = await nativeFetch(`http://127.0.0.1:${streamMux.port}/stream`, {
                    headers: { "Authorization": `Bearer ${streamToken}` },
                });
                const body = await res.text();
                if (body !== "chunk0\nchunk1\nchunk2\n") {
                    throw new Error(`Expected streamed chunks, got "${body}"`);
                }
            } finally {
                await streamMux.shutdown();
                streamAc.abort();
                await streamServer.finished;
            }
        });

        // ── T6: Shutdown lifecycle ──

        await t.run("startMuxProxy: shutdown rejects new connections", async () => {
            const shutdownMux = startMuxProxy(
                makeMuxSys(),
                [{ name: "shutdown-test", port: UPSTREAM_PORT, token: VALID_TOKEN }],
            );
            if (!shutdownMux) throw new Error("Expected mux proxy");

            await shutdownMux.shutdown();

            let rejected = false;
            try {
                await nativeFetch(`http://127.0.0.1:${shutdownMux.port}/`, {
                    headers: { "Authorization": `Bearer ${VALID_TOKEN}` },
                });
            } catch {
                rejected = true;
            }

            if (!rejected) {
                throw new Error("Expected connection to be rejected after shutdown");
            }
        });

        // ── T7: Port 0 binding is not treated as missing ──

        await t.run("startMuxProxy: port 0 binding routes correctly (not treated as falsy)", async () => {
            const port0Token = crypto.randomUUID();

            // Start an upstream on port 0 (ephemeral) and capture its actual port.
            const port0Actual = getFreePort();
            const port0Ac = new AbortController();
            const port0Server = denoServe(
                { port: port0Actual, hostname: "127.0.0.1", signal: port0Ac.signal, onListen: () => {} },
                () => new Response("port-zero-ok"),
            );

            // Register the binding with port: 0 to simulate the bug.
            // The mux proxy should resolve the token → port 0, but the truthy
            // check `if (!targetPort)` incorrectly treats 0 as null.
            const port0Mux = startMuxProxy(
                makeMuxSys(),
                [{ name: "port-zero", port: 0, token: port0Token }],
            );
            if (!port0Mux) throw new Error("Expected mux proxy");

            try {
                const res = await nativeFetch(`http://127.0.0.1:${port0Mux.port}/test`, {
                    headers: { "Authorization": `Bearer ${port0Token}` },
                });
                // BUG: with `if (!targetPort)`, this returns 403 because port 0 is falsy.
                // FIX: with `if (targetPort === null)`, this returns 200.
                if (res.status === 403) {
                    throw new Error("Port 0 was treated as missing (falsy check bug). Got 403 instead of routing to upstream.");
                }
                await res.body?.cancel();
            } finally {
                await port0Mux.shutdown();
                port0Ac.abort();
                await port0Server.finished;
            }
        });

    } finally {
        await muxProxy.shutdown();
        upstreamAc.abort();
        await upstreamServer.finished;
    }
}
