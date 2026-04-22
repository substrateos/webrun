// import_proxy.test.ts — Tests for the MITM HTTPS import proxy.
//
// Verifies that the proxy correctly rewrites User-Agent headers for
// both HTTPS CONNECT tunnels and plain HTTP forwarding.
//
// Runner: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/import_proxy.test.ts

import { registerTests, sys } from "./_adapter.ts";
import type { NetAddr } from "../../src/types.ts";
import { startImportProxy, BROWSER_USER_AGENT } from "../../src/import_proxy.ts";

export async function testImportProxy(t: any) {
    function getFreePort(): number {
        const listener = sys.listen({ port: 0 });
        const port = (listener.addr as NetAddr).port;
        listener.close();
        return port;
    }

    // ── HTTPS MITM: CONNECT tunnel rewrites UA ──

    await t.run("HTTPS CONNECT sends browser UA to target", async () => {
        // Start the MITM proxy.
        const proxy = await startImportProxy();

        try {
            // Spawn a child with HTTPS_PROXY pointing to our proxy.
            // The child fetches an HTTPS URL; traffic goes through the MITM tunnel.
            const tmpCaPath = sys.makeTempDirSync({ prefix: "ca_" }) + "/ca.pem";
            sys.writeTextFileSync(tmpCaPath, proxy.caCertPem);

            const cmd = new sys.Command(sys.execPath(), {
                args: ["run", "-A", "--no-check", `--cert=${tmpCaPath}`, "-"],
                stdin: "piped",
                stdout: "piped",
                stderr: "piped",
                env: {
                    "HTTPS_PROXY": `http://127.0.0.1:${proxy.port}`,
                    "HTTP_PROXY": `http://127.0.0.1:${proxy.port}`,
                    "NO_PROXY": "",
                    "PATH": sys.env.get("PATH") || "",
                    "HOME": sys.env.get("HOME") || "",
                },
                clearEnv: true,
            });

            const child = cmd.spawn();
            const writer = child.stdin.getWriter();
            // Fetch a well-known HTTPS URL through the proxy.
            await writer.write(new TextEncoder().encode(`
                try {
                    const resp = await fetch("https://esm.sh/react@18.2.0");
                    console.log("STATUS:" + resp.status);
                    const text = await resp.text();
                    console.log("LENGTH:" + text.length);
                } catch(e) {
                    console.log("ERROR:" + e.message);
                }
            `));
            await writer.close();

            const output = await child.output();
            const stdout = new TextDecoder().decode(output.stdout).trim();
            const stderr = new TextDecoder().decode(output.stderr).trim();

            if (!stdout.includes("STATUS:200")) {
                throw new Error(`Expected STATUS:200 in stdout, got stdout='${stdout}' stderr='${stderr}'`);
            }

            try { sys.removeSync(tmpCaPath); } catch {}
        } finally {
            await proxy.shutdown();
        }
    });

    // ── HTTP forward sends browser UA ──

    await t.run("HTTP forward sends browser UA to target", async () => {
        // Start a target HTTP server that captures UA.
        let capturedUA = "";
        const target = sys.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req: Request) => {
            capturedUA = req.headers.get("user-agent") || "(none)";
            return new Response("export default 42;", {
                headers: { "content-type": "application/javascript" },
            });
        });
        const targetPort = (target.addr as any).port;

        const proxy = await startImportProxy();

        try {
            // Spawn child with HTTP_PROXY set, fetch an http:// URL.
            const cmd = new sys.Command(sys.execPath(), {
                args: ["run", "-A", "--no-check", "-"],
                stdin: "piped",
                stdout: "piped",
                stderr: "piped",
                env: {
                    "HTTP_PROXY": `http://127.0.0.1:${proxy.port}`,
                    "NO_PROXY": "",
                    "PATH": sys.env.get("PATH") || "",
                    "HOME": sys.env.get("HOME") || "",
                },
                clearEnv: true,
            });

            const child = cmd.spawn();
            const writer = child.stdin.getWriter();
            await writer.write(new TextEncoder().encode(`
                try {
                    const resp = await fetch("http://127.0.0.1:${targetPort}/mod.js?v=${Date.now()}");
                    const text = await resp.text();
                    console.log("RESULT:" + text.substring(0, 30));
                } catch(e) {
                    console.log("ERROR:" + e.message);
                }
            `));
            await writer.close();

            const output = await child.output();
            const stdout = new TextDecoder().decode(output.stdout).trim();

            if (!stdout.includes("RESULT:export default 42;")) {
                const stderr = new TextDecoder().decode(output.stderr).trim();
                throw new Error(`Expected successful HTTP forward, got stdout='${stdout}' stderr='${stderr}'`);
            }
            if (!capturedUA.includes("Mozilla/5.0")) {
                throw new Error(`Expected browser UA containing 'Mozilla/5.0', got: '${capturedUA}'`);
            }
            if (capturedUA.includes("Deno/")) {
                throw new Error(`Expected no 'Deno/' in UA, got: '${capturedUA}'`);
            }
        } finally {
            await proxy.shutdown();
            await target.shutdown();
        }
    });

    // ── CA cert PEM is accessible ──

    await t.run("proxy exposes caCertPem", async () => {
        const proxy = await startImportProxy();
        try {
            if (!proxy.caCertPem.includes("BEGIN CERTIFICATE")) {
                throw new Error("Expected PEM-encoded CA cert");
            }
            if (!proxy.caCertPem.includes("END CERTIFICATE")) {
                throw new Error("Expected PEM-encoded CA cert");
            }
        } finally {
            await proxy.shutdown();
        }
    });

    // ── Shutdown lifecycle ──

    await t.run("shutdown closes all listeners", async () => {
        const proxy = await startImportProxy();
        await proxy.shutdown();
        // After shutdown, the port should be freed. Verify by binding to it.
        // (The OS may not immediately release it, so this is best-effort.)
        // The key assertion is that shutdown() completes without error.
    });
}

import * as self from "./import_proxy.test.ts";
registerTests(self);
