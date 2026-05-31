import { udsSpawn } from "./spawner.ts";
import { expose, proxy, JSONStream } from "../core/fdlink/rpc.ts";
import type { Connection, Pipe, TransferHandle } from "../core/fdlink/types.ts";
import { ConnectionClosed } from "../core/fdlink/types.ts";
import { makeFdlink } from "../core/fdlink/mod.ts";

export async function testSpawnerResourceLeak(t: any) {
    await t.run("conn.close() is called even if exitCode rejects", async (inner: any) => {
        // Use the REAL transport but spy on connect() to track close()
        const realTransport = makeFdlink(Deno as any);
        
        let clientClosedIt = false;
        const transport = {
            ...realTransport,
            connect(path: string) {
                const conn = realTransport.connect(path);
                const originalClose = conn.close;
                conn.close = () => {
                    clientClosedIt = true;
                    originalClose.call(conn);
                };
                return conn;
            }
        };
        
        // Generate a valid socket path
        const socketPath = await Deno.makeTempFile();
        await Deno.remove(socketPath); // listen() requires path to not exist
        
        const listener = transport.listen(socketPath);

        // Start udsSpawn asynchronously so it blocks on the connect/spawn RPC
        const spawnPromise = udsSpawn(transport, socketPath, "token", {
            command: "test", args: [], env: {}, cwd: "/", pipeStdin: false
        });

        // Accept the real UDS connection from udsSpawn
        const serverConn = await listener.accept();

        const crashPromise = Promise.reject(new Error("simulated crash"));
        crashPromise.catch(() => {}); // Prevent unhandled rejection crash during IPC delay

        const impl = {
            spawn: () => proxy({
                pid: 123,
                exitCode: crashPromise,
                signal: () => {}
            })
        };
        
        // Expose the mock spawner API over the real socket
        serverConn.send(new TextEncoder().encode("{}\n"));
        expose(impl, new JSONStream(serverConn));

        // Await the spawned child handle
        const handle = await spawnPromise;

        // Await its exitCode, which we configured to reject
        let rejection: any;
        try {
            await handle.exitCode;
        } catch (e) {
            rejection = e;
        }

        inner.assert(rejection?.message?.includes("simulated crash"), "Expected exitCode to reject with simulated crash");
        
        inner.assert(clientClosedIt === true, "Expected client connection to be closed upon exitCode rejection to prevent resource leaks");
        
        serverConn.close();
        listener.close();
    });
}
