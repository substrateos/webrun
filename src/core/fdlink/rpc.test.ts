import { expose, wrap, proxy, JSONStream } from "./rpc.ts";
import type { TransferHandle } from "./types.ts";
import { ConnectionClosed } from "./types.ts";
import { makeFdlink } from "./mod.ts";

// ── In-Memory Stream Transport ───────────────────────────────────────────────────
// Connects the RPC client and server using real Unix Domain Sockets via fdlink.

async function setupRealTransport() {
    const transport = makeFdlink(Deno as any);
    const socketPath = await Deno.makeTempFile();
    await Deno.remove(socketPath); // listener requires path to not exist
    
    const listener = transport.listen(socketPath);
    const clientConn = transport.connect(socketPath);
    const serverConn = await listener.accept();
    
    const client = new JSONStream(clientConn);
    const server = new JSONStream(serverConn);
    
    return { client, server, clientConn, serverConn, listener };
}

// ── Tests ────────────────────────────────────────────────────────────────────

type RpcCase = {
    name: string;
    method: string;
    args?: any[];
    expectResult?: any;
    expectErrorContains?: string;
};

const rpcCases: RpcCase[] = [
    {
        name: "Valid direct method call",
        method: "hello",
        expectResult: "world",
    },
    {
        name: "Prototype method (toString) is rejected",
        method: "toString",
        expectErrorContains: "Invalid or unauthorized method",
    },
    {
        name: "Prototype method (valueOf) is rejected",
        method: "valueOf",
        expectErrorContains: "Invalid or unauthorized method",
    },
    {
        name: "Constructor is rejected",
        method: "constructor",
        expectErrorContains: "Invalid or unauthorized method",
    },
    {
        name: "__proto__ is rejected",
        method: "__proto__",
        expectErrorContains: "Invalid or unauthorized method",
    },
];

export async function testRpcPrototypeExposure(t: any) {
    for (const tc of rpcCases) {
        await t.run(tc.name, async (inner: any) => {
            const { client, server, clientConn, listener } = await setupRealTransport();
            
            // Server implementation
            const impl = {
                hello: () => "world"
            };
            
            // The expose implementation expects a synchronous first message.
            // Prime the buffer via the underlying raw connection.
            clientConn.send(new TextEncoder().encode("{}\n"));
            expose(impl, server);

            const remote: any = wrap(client);
            
            try {
                // Call the method
                const result = await remote[tc.method](...(tc.args || []));
                if (tc.expectErrorContains) {
                    throw new Error(`UNEXPECTED_SUCCESS: Expected failure containing "${tc.expectErrorContains}", but got ${result}`);
                }
                inner.assert(result === tc.expectResult, `Expected ${tc.expectResult}, got ${result}`);
            } catch (e: any) {
                if (e.message.startsWith("UNEXPECTED_SUCCESS")) throw e;
                if (!tc.expectErrorContains) throw e;
                inner.assert(
                    e.message.includes(tc.expectErrorContains),
                    `Expected error to contain "${tc.expectErrorContains}", got: ${e.message}`
                );
            } finally {
                client.close();
                server.close();
                listener.close();
            }
        });
    }
}

export async function testRpcExplicitTeardown(t: any) {
    await t.run("Disposed proxies are explicitly released from the server", async (inner: any) => {
        const { client, server, clientConn, listener } = await setupRealTransport();
        
        const api = { getSecret: () => proxy({ data: "secret" }) };
        
        // Prime the stream with a synchronous first message.
        clientConn.send(new TextEncoder().encode("{}\n"));
        expose(api, server);
        
        const remote: any = wrap(client);

        let proxyRef: any;
        
        {
            await using secretProxy = await remote.getSecret();
            proxyRef = secretProxy;
            const data = await secretProxy.data;
            inner.assert(data === "secret", "Proxy should work inside scope");
        } // `[Symbol.asyncDispose]()` fires here and sends 'release'
        
        try {
            await proxyRef.data;
            throw new Error("UNEXPECTED_SUCCESS: Proxy should be dead");
        } catch (e: any) {
            if (e.message.includes("UNEXPECTED_SUCCESS")) throw e;
            inner.assert(
                e.message.includes("Unknown proxy"), 
                `Expected "Unknown proxy" error, got: ${e.message}`
            );
        } finally {
            client.close();
            server.close();
            listener.close();
        }
    });
}
