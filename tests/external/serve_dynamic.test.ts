// serve_dynamic.test.ts — Serve tests requiring dynamic import() and WebSocket.
//
// Requires: nativeFetch, dynamic import from localhost, WebSocket.
// Runner: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/serve_dynamic.test.ts

import { denoTest } from "./_adapter.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

function getFreePort(): number {
    const listener = Deno.listen({ port: 0 });
    const port = (listener.addr as Deno.NetAddr).port;
    listener.close();
    return port;
}

denoTest("ServeDynamic", async (t) => {
    const WORKER_BIN = Deno.env.get("WEBRUN_BIN") || join(dirname(new URL(import.meta.url).pathname), "../../webrun");

    await t.run("End-to-End Fetch Dynamic Script Shim", async () => {
        const port = getFreePort();
        const tmpApi = Deno.makeTempDirSync();
        Deno.writeTextFileSync(`${tmpApi}/webrun.json`, '{"permissions":{"storage":{".":{  "access":"read"}}}}');
        Deno.writeTextFileSync(`${tmpApi}/api.js`, "export const answer = 42; export function calculate() { return answer; }");

        const p = new Deno.Command(WORKER_BIN, {
            args: ["--serve", `--bind=127.0.0.1:${port}`, "--module", "api.js"],
            cwd: tmpApi,
            stdout: "inherit",
            stderr: "inherit"
        }).spawn();

        for (let i = 0; i < 50; i++) {
            try {
                await fetch(`http://127.0.0.1:${port}`);
                break;
            } catch (_) {
                await new Promise((r) => setTimeout(r, 50));
            }
        }
        try {
            const module = await import(`http://127.0.0.1:${port}`);
            if (module.answer !== 42 || module.calculate() !== 42) throw new Error("Incorrect result from fn: calculate.");
        } finally {
            try { p.kill("SIGTERM"); await p.status; } catch (_) {}
        }
    });

    await t.run("WebSocket Upgrade and Echo Protocol", async () => {
        const port = getFreePort();
        const tmpApi = Deno.makeTempDirSync();
        Deno.writeTextFileSync(`${tmpApi}/webrun.json`, '{"permissions":{"storage":{".":{  "access":"read"}}}}');
        Deno.writeTextFileSync(`${tmpApi}/ws_server.js`, `
import { upgradeWebSocket } from "webrun/ctx";

export default {
    async fetch(req) {
        if (req.headers.get("upgrade") === "websocket" || req.headers.get("Upgrade") === "websocket") {
            const { socket, response } = upgradeWebSocket(req);
            socket.onmessage = (e) => {
                socket.send("ECHO:" + e.data);
            };
            return response;
        }
        return new Response("OK");
    }
}
`);

        const p = new Deno.Command(WORKER_BIN, {
            args: ["--serve", `--bind=127.0.0.1:${port}`, "--module", "ws_server.js"],
            cwd: tmpApi,
            stdout: "null",
            stderr: "null"
        }).spawn();

        for (let i = 0; i < 50; i++) {
            try {
                await fetch(`http://127.0.0.1:${port}/`);
                break;
            } catch (_) {
                await new Promise((r) => setTimeout(r, 50));
            }
        }

        try {
            const res = await fetch(`http://127.0.0.1:${port}/`);
            if (await res.text() !== "OK") throw new Error("Parallel HTTP protocol failed");

            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("WebSocket echo timed out after 5s")), 5000);
                const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
                ws.onopen = () => ws.send("HELLO");
                ws.onmessage = (e) => {
                    if (e.data === "ECHO:HELLO") {
                        clearTimeout(timeout);
                        ws.close();
                        resolve();
                    } else {
                        clearTimeout(timeout);
                        reject(new Error("Bad echo: " + e.data));
                    }
                };
                ws.onerror = (e) => { clearTimeout(timeout); reject(new Error("WS error: " + e)); };
            });
        } finally {
            try { p.kill("SIGTERM"); await p.status; } catch (_) {}
        }
    });
});
