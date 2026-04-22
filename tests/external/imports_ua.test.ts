// imports_ua.test.ts — Tests for import permission serialization and
// browser-like User-Agent injection.
//
// Runner: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/imports_ua.test.ts

import { registerTests, sys } from "./_adapter.ts";
import { serializePermissions, toDenoPermissions } from "../../src/jail.ts";
import type { ResolvedCapabilities } from "../../src/jail.ts";
import { buildRuntimeArgs } from "../../src/jail.ts";
import type { RuntimeArgsInput } from "../../src/jail.ts";

// =========================================================
// Helpers
// =========================================================

/** Build a minimal ResolvedCapabilities with import hosts overridden. */
function capsWithImports(importHosts: string[]): ResolvedCapabilities {
    return {
        readPaths: ["/tmp"],
        writePaths: ["/tmp"],
        execPaths: ["/usr/bin/deno"],
        networkConnect: [80, 443],
        networkBind: [],
        env: ["TMP_DIR"],
        gpu: false,
        networkFlags: ["--deny-net"],
        isLinux: false,
        importHosts,
    };
}

export async function testImportPermissions(t: any) {
    // ── Import Permission Tests ──

    await t.run("toDenoPermissions: empty importHosts → import=false", async () => {
        const perms = toDenoPermissions(capsWithImports([]));
        if (perms.import !== false) {
            throw new Error(`Expected import=false, got ${perms.import}`);
        }
    });

    await t.run("toDenoPermissions: importHosts=['*'] → import=true, importHosts=[]", async () => {
        const perms = toDenoPermissions(capsWithImports(["*"]));
        if (perms.import !== true) {
            throw new Error(`Expected import=true, got ${perms.import}`);
        }
        if (perms.importHosts.length !== 0) {
            throw new Error(`Expected empty importHosts for wildcard, got ${JSON.stringify(perms.importHosts)}`);
        }
    });

    await t.run("toDenoPermissions: specific hosts → import=true, importHosts preserved", async () => {
        const perms = toDenoPermissions(capsWithImports(["esm.sh", "cdn.jsdelivr.net"]));
        if (perms.import !== true) {
            throw new Error(`Expected import=true, got ${perms.import}`);
        }
        if (perms.importHosts.length !== 2 || perms.importHosts[0] !== "esm.sh") {
            throw new Error(`Expected ['esm.sh', 'cdn.jsdelivr.net'], got ${JSON.stringify(perms.importHosts)}`);
        }
    });

    await t.run("serializePermissions: import=false → no --allow-import flag", async () => {
        const perms = toDenoPermissions(capsWithImports([]));
        const flags = serializePermissions(perms);
        const importFlags = flags.filter(f => f.includes("--allow-import"));
        if (importFlags.length !== 0) {
            throw new Error(`Expected no --allow-import, got ${JSON.stringify(importFlags)}`);
        }
    });

    await t.run("serializePermissions: wildcard → bare --allow-import", async () => {
        const perms = toDenoPermissions(capsWithImports(["*"]));
        const flags = serializePermissions(perms);
        const importFlags = flags.filter(f => f.includes("--allow-import"));
        if (importFlags.length !== 1 || importFlags[0] !== "--allow-import") {
            throw new Error(`Expected bare --allow-import, got ${JSON.stringify(importFlags)}`);
        }
    });

    await t.run("serializePermissions: specific hosts → --allow-import=host1,host2", async () => {
        const perms = toDenoPermissions(capsWithImports(["esm.sh", "cdn.jsdelivr.net"]));
        const flags = serializePermissions(perms);
        const importFlags = flags.filter(f => f.includes("--allow-import"));
        if (importFlags.length !== 1) {
            throw new Error(`Expected 1 --allow-import flag, got ${JSON.stringify(importFlags)}`);
        }
        if (importFlags[0] !== "--allow-import=esm.sh,cdn.jsdelivr.net") {
            throw new Error(`Expected --allow-import=esm.sh,cdn.jsdelivr.net, got ${importFlags[0]}`);
        }
    });
}

export async function testCertFlag(t: any) {
    await t.run("buildRuntimeArgs includes --cert when caCertPath is provided", async () => {
        const input: RuntimeArgsInput = {
            invocation: {
                action: "run",
                targetScriptPath: "/tmp/script.ts",
                sandboxArgs: [],
                injectedArgsObj: {},
                networkFlags: [],
            },
            importMapPath: "/tmp/import_map.json",
            paths: {
                projectRoot: "/tmp",
                cwd: "/tmp",
                localCacheDir: "/tmp/cache",
                isolatedTmp: "/tmp/iso",
                runnerTmp: "/tmp/run",
                opfsTmp: "/tmp/opfs",
                bindingSdksTmp: "/tmp/sdks",
                webrunEntryPath: "/tmp/webrun.ts",
                isSourceMode: true,
            },
            payloadPath: "/tmp/payload.json",
            caps: capsWithImports(["deno.land", "jsr.io"]),
            caCertPath: "/tmp/iso/webrun_ca.pem",
        };

        const args = buildRuntimeArgs(input);
        const certFlags = args.filter(a => a.startsWith("--cert="));
        if (certFlags.length !== 1) {
            throw new Error(`Expected exactly 1 --cert flag, got ${JSON.stringify(certFlags)}`);
        }
        if (certFlags[0] !== "--cert=/tmp/iso/webrun_ca.pem") {
            throw new Error(`Expected --cert=/tmp/iso/webrun_ca.pem, got ${certFlags[0]}`);
        }
    });

    await t.run("buildRuntimeArgs omits --cert when caCertPath is undefined", async () => {
        const input: RuntimeArgsInput = {
            invocation: {
                action: "run",
                targetScriptPath: "/tmp/script.ts",
                sandboxArgs: [],
                injectedArgsObj: {},
                networkFlags: [],
            },
            importMapPath: "/tmp/import_map.json",
            paths: {
                projectRoot: "/tmp",
                cwd: "/tmp",
                localCacheDir: "/tmp/cache",
                isolatedTmp: "/tmp/iso",
                runnerTmp: "/tmp/run",
                opfsTmp: "/tmp/opfs",
                bindingSdksTmp: "/tmp/sdks",
                webrunEntryPath: "/tmp/webrun.ts",
                isSourceMode: true,
            },
            payloadPath: "/tmp/payload.json",
            caps: capsWithImports(["deno.land", "jsr.io"]),
        };

        const args = buildRuntimeArgs(input);
        const certFlags = args.filter(a => a.startsWith("--cert="));
        if (certFlags.length !== 0) {
            throw new Error(`Expected no --cert flag, got ${JSON.stringify(certFlags)}`);
        }
    });
}

export async function testUserAgentInjection(t: any) {
    // ── User-Agent Tests ──

    await t.run("guest fetch() sends browser-like User-Agent", async () => {
        const { createCliAdapter } = await import("../../src/adapters/cli.ts");

        let capturedUA = "";
        const server = sys.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req: Request) => {
            capturedUA = req.headers.get("user-agent") || "";
            return new Response("ok");
        });

        try {
            const mockSys = {
                exit: () => {},
                memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
                stdout: Deno.stdout,
                stderr: Deno.stderr,
                stdin: Deno.stdin,
                addSignalListener: () => {},
                readTextFileSync: () => "",
                writeTextFileSync: () => {},
                mkdirSync: () => {},
                env: { get: () => undefined, set: () => {} },
                build: { os: "darwin" },
                consoleSize: () => ({ columns: 80, rows: 24 }),
                networkInterfaces: () => [],
            };

            const adapter = createCliAdapter(mockSys as any);
            const nativeFetch = adapter.captureFetch();

            const resp1 = await globalThis.fetch(`http://127.0.0.1:${(server.addr as any).port}/test`);
            await resp1.text();

            if (!capturedUA.includes("Mozilla/5.0")) {
                throw new Error(`Expected browser-like UA containing 'Mozilla/5.0', got: '${capturedUA}'`);
            }
            if (!capturedUA.includes("AppleWebKit")) {
                throw new Error(`Expected browser-like UA containing 'AppleWebKit', got: '${capturedUA}'`);
            }

            // Verify nativeFetch still sends Deno's default UA.
            capturedUA = "";
            const resp2 = await nativeFetch(`http://127.0.0.1:${(server.addr as any).port}/test`);
            await resp2.text();
            if (!capturedUA.includes("Deno/")) {
                throw new Error(`Expected nativeFetch to send 'Deno/' UA, got: '${capturedUA}'`);
            }
        } finally {
            await server.shutdown();
        }
    });

    await t.run("guest fetch() preserves explicit User-Agent", async () => {
        const { createCliAdapter } = await import("../../src/adapters/cli.ts");

        let capturedUA = "";
        const server = sys.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req: Request) => {
            capturedUA = req.headers.get("user-agent") || "";
            return new Response("ok");
        });

        try {
            const mockSys = {
                exit: () => {},
                memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
                stdout: Deno.stdout,
                stderr: Deno.stderr,
                stdin: Deno.stdin,
                addSignalListener: () => {},
                readTextFileSync: () => "",
                writeTextFileSync: () => {},
                mkdirSync: () => {},
                env: { get: () => undefined, set: () => {} },
                build: { os: "darwin" },
                consoleSize: () => ({ columns: 80, rows: 24 }),
                networkInterfaces: () => [],
            };

            const adapter = createCliAdapter(mockSys as any);
            adapter.captureFetch();

            const resp = await globalThis.fetch(`http://127.0.0.1:${(server.addr as any).port}/test`, {
                headers: { "User-Agent": "CustomBot/1.0" },
            });
            await resp.text();

            if (capturedUA !== "CustomBot/1.0") {
                throw new Error(`Expected 'CustomBot/1.0', got: '${capturedUA}'`);
            }
        } finally {
            await server.shutdown();
        }
    });
}

import * as self from "./imports_ua.test.ts";
registerTests(self);
