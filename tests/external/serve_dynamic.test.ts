// serve_dynamic.test.ts — Serve tests requiring dynamic import() and WebSocket.
//
// Requires: nativeFetch, dynamic import from localhost, WebSocket.
// Runner: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/serve_dynamic.test.ts

import { registerTests, sys } from "./_adapter.ts";
import { WEBRUN_BIN } from "./_cli_runner.ts";
import { dirname, join } from "https://deno.land/std@0.224.0/path/mod.ts";
import type { NetAddr } from "../../src/types.ts";

function getFreePort(): number {
    const listener = sys.listen({ port: 0 });
    const port = (listener.addr as NetAddr).port;
    listener.close();
    return port;
}

export async function testServeDynamic(t: any) {

    await t.run("End-to-End Fetch Dynamic Script Shim", async () => {
        const port = getFreePort();
        const tmpApi = sys.makeTempDirSync();
        sys.writeTextFileSync(`${tmpApi}/webrun.json`, '{"permissions":{"storage":{".":{  "access":"read"}}}}');
        sys.writeTextFileSync(`${tmpApi}/api.js`, "export const answer = 42; export function calculate() { return answer; }");

        const p = new sys.Command(WEBRUN_BIN, {
            args: ["--serve", `--bind=127.0.0.1:${port}`, "api.js"],
            cwd: tmpApi,
            stdout: "piped",
            stderr: "piped"
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
        } catch (e) {
            const [stdout, stderr] = await Promise.all([
                new Response(p.stdout).text(),
                new Response(p.stderr).text(),
            ]);
            console.error("--- subprocess stdout ---\n" + stdout);
            console.error("--- subprocess stderr ---\n" + stderr);
            throw e;
        } finally {
            try { p.kill("SIGTERM"); await p.status; } catch (_) {}
        }
    });

    await t.run("WebSocket Upgrade and Echo Protocol", async () => {
        const port = getFreePort();
        const tmpApi = sys.makeTempDirSync();
        sys.writeTextFileSync(`${tmpApi}/webrun.json`, '{"permissions":{"storage":{".":{  "access":"read"}}}}');
        sys.writeTextFileSync(`${tmpApi}/ws_server.js`, `
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

        const p = new sys.Command(WEBRUN_BIN, {
            args: ["--serve", `--bind=127.0.0.1:${port}`, "ws_server.js"],
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
}

import * as self from "./serve_dynamic.test.ts";
registerTests(self);
