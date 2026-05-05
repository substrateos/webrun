// security_host.test.ts — Security regression tests.
//
// Spawns real webrun processes to verify that the sandbox and binding
// isolation boundaries hold under adversarial conditions.

import { registerTests, sys } from "./_adapter.ts";
import { WEBRUN_BIN, copyDirRecursive } from "./_cli_runner.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

export async function testSecurityHost(t: any) {

    // ── Import map cannot override node sinkhole ────────────────────────
    //
    // A user-supplied importMap that remaps node:path must not bypass the
    // built-in sinkhole. The sinkhole must always take precedence.

    await t.run("user import map cannot override node:path sinkhole", async () => {
        const fixtureDir = sys.realPathSync(sys.makeTempDirSync({ prefix: "sinkhole_" }));

        sys.writeTextFileSync(join(fixtureDir, "custom_map.json"), JSON.stringify({
            imports: {
                "node:path": "./my_path.ts",
            }
        }));

        sys.writeTextFileSync(join(fixtureDir, "my_path.ts"),
`export function join(...args) { return "OVERRIDDEN:" + args.join("/"); }
`);

        sys.writeTextFileSync(join(fixtureDir, "main.ts"),
`try {
    const path = await import("node:path");
    if (typeof path.join === "function") {
        const result = path.join("a", "b");
        if (result.startsWith("OVERRIDDEN:")) {
            console.log("SINKHOLE_BYPASSED");
        } else {
            console.log("REAL_NODE_PATH");
        }
    } else {
        console.log("SINKHOLE_ACTIVE");
    }
} catch (e) {
    console.log("SINKHOLE_THREW:" + e.message);
}
`);

        sys.writeTextFileSync(join(fixtureDir, "webrun.json"), JSON.stringify({
            locations: { default: "main.ts" },
            importMap: "custom_map.json",
            permissions: {
                storage: { ".": { access: "read" } },
            }
        }));

        const cmd = new sys.Command(WEBRUN_BIN, {
            args: ["main.ts"],
            cwd: fixtureDir,
            stdout: "piped",
            stderr: "piped",
        });
        const out = await cmd.output();
        const stdout = new TextDecoder().decode(out.stdout);
        const stderr = new TextDecoder().decode(out.stderr);

        try { sys.removeSync(fixtureDir, { recursive: true }); } catch (_) {}

        if (stdout.includes("SINKHOLE_BYPASSED")) {
            throw new Error(
                "VULNERABILITY: user import map overrode node:path sinkhole.\n" +
                `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`
            );
        }

        if (!stdout.includes("SINKHOLE_THREW") && !stdout.includes("SINKHOLE_ACTIVE")) {
            if (stdout.includes("REAL_NODE_PATH")) {
                throw new Error(
                    "VULNERABILITY: sinkhole bypassed — real node:path loaded.\n" +
                    `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`
                );
            }
            throw new Error(
                `Unexpected output.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
            );
        }
    });

    // ── Binding without permissions.env does not leak host secrets ───────
    //
    // A binding whose processConfig omits permissions.env should receive
    // only the restricted base env. Host secrets must not leak through.

    await t.run("binding without permissions.env does not receive host secrets", async () => {
        const fixtureDir = sys.realPathSync(sys.makeTempDirSync({ prefix: "env_leak_" }));

        sys.writeTextFileSync(join(fixtureDir, "env_echo.ts"),
`const port = parseInt(Deno.env.get("PORT") || "0", 10);
Deno.serve({ port, hostname: "127.0.0.1" }, () => {
    return new Response(JSON.stringify(Deno.env.toObject()));
});
`);

        sys.writeTextFileSync(join(fixtureDir, "main.ts"),
`export default async function(ctx) {
    const res = await ctx.bindings.echoenv.fetch("/");
    const env = await res.json();
    const secrets = ["CANARY_SECRET", "ANOTHER_SECRET"];
    const leaked = secrets.filter(k => env[k] !== undefined);
    if (leaked.length > 0) {
        console.log("ENV_LEAKED:" + leaked.join(","));
    } else {
        console.log("ENV_RESTRICTED_OK");
    }
}
`);

        sys.writeTextFileSync(join(fixtureDir, "webrun.json"), JSON.stringify({
            locations: { default: "main.ts" },
            permissions: {
                storage: { ".": { access: "read" } },
                bindings: ["echoenv"],
            },
            bindings: {
                echoenv: {
                    process: {
                        command: ["deno", "run", "-A", "env_echo.ts"],
                        portEnv: "PORT",
                    },
                },
            },
        }));

        const cmd = new sys.Command(WEBRUN_BIN, {
            args: ["main.ts"],
            cwd: fixtureDir,
            env: {
                CANARY_SECRET: "leaked_if_visible",
                ANOTHER_SECRET: "also_leaked",
            },
            stdout: "piped",
            stderr: "piped",
        });
        const out = await cmd.output();
        const stdout = new TextDecoder().decode(out.stdout);
        const stderr = new TextDecoder().decode(out.stderr);

        try { sys.removeSync(fixtureDir, { recursive: true }); } catch (_) {}

        if (stdout.includes("ENV_LEAKED:")) {
            throw new Error(
                "Binding process received host secrets when permissions.env is absent.\n" +
                `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`
            );
        }

        if (!stdout.includes("ENV_RESTRICTED_OK") && !stdout.includes("ENV_LEAKED:")) {
            throw new Error(
                `Test script did not produce expected output.\n` +
                `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`
            );
        }
    });

    // ── Sandbox write paths exclude protected directories ────────────────
    //
    // resolveCapabilities produces the write set for the OS sandbox.
    // The write paths must never include the deno binary directory or the
    // cache root — only the narrow modules/<uaHash> subdirectory.

    await t.run("sandbox write paths exclude deno binary and cache root", async () => {
        const { resolveCapabilities } = await import("../../src/jail.ts");

        const home = sys.realPathSync(Deno.env.get("HOME") || "/tmp");
        const cacheRoot = join(home, ".cache", "webrun");
        const denoDir = join(cacheRoot, "deno");
        const moduleCache = join(cacheRoot, "modules", "test_hash");

        const fixtureDir = sys.realPathSync(sys.makeTempDirSync({ prefix: "writescope_" }));
        const isolatedTmp = sys.realPathSync(sys.makeTempDirSync({ prefix: "writescope_tmp_" }));

        const fakePaths = {
            projectRoot: fixtureDir,
            cwd: fixtureDir,
            localCacheDir: moduleCache,
            isolatedTmp: isolatedTmp,
            runnerTmp: join(isolatedTmp, "runner"),
            opfsTmp: join(isolatedTmp, "opfs"),
            bindingSdksTmp: join(isolatedTmp, "sdks"),
            webrunEntryPath: join(fixtureDir, "webrun.ts"),
            isSourceMode: false,
        };

        const policy = {
            isPwdAllowed: false,
            fallbackToTemp: true,
            storageRoot: fixtureDir,
            allowedReadPaths: [] as string[],
            allowedWritePaths: [] as string[],
            allowedBindings: [] as string[],
        };

        const os = Deno.build.os === "darwin" ? "darwin" : "linux";
        const caps = resolveCapabilities(sys as any, policy, fakePaths, [], false, os, [], []);

        const writePaths = caps.writePaths;
        const violations: string[] = [];

        for (const wp of writePaths) {
            if (cacheRoot === wp || denoDir === wp || cacheRoot.startsWith(wp + "/")) {
                violations.push(`writePath "${wp}" grants access to cache root or deno binary`);
            }
            if (wp === denoDir || denoDir.startsWith(wp + "/")) {
                violations.push(`writePath "${wp}" grants access to deno binary dir`);
            }
        }

        try { sys.removeSync(fixtureDir, { recursive: true }); } catch (_) {}
        try { sys.removeSync(isolatedTmp, { recursive: true }); } catch (_) {}

        if (violations.length > 0) {
            throw new Error(
                "VULNERABILITY: sandbox write paths include protected directories:\n" +
                violations.map(v => `  - ${v}`).join("\n") +
                `\nwritePaths: ${JSON.stringify(writePaths)}`
            );
        }

        if (!writePaths.some((wp: string) => moduleCache.startsWith(wp))) {
            throw new Error(
                `Module cache "${moduleCache}" is not writable — sandbox can't download modules.\n` +
                `writePaths: ${JSON.stringify(writePaths)}`
            );
        }
    });

    // ── Binding cannot write to protected system paths ───────────────────
    //
    // A binding subprocess (sandboxed via seatbelt on macOS, Landlock on
    // Linux) must not be able to write to the deno binary directory or
    // the shared module cache, even when the user configures it with -A.

    await t.run("binding cannot write to deno binary or module cache", async () => {
        const fixtureDir = sys.realPathSync(sys.makeTempDirSync({ prefix: "bindwrite_" }));

        const home = sys.realPathSync(Deno.env.get("HOME") || "/tmp");
        const denoDir = join(home, ".cache", "webrun", "deno");
        const moduleCacheDir = join(home, ".cache", "webrun", "modules");

        sys.writeTextFileSync(join(fixtureDir, "probe_writer.ts"),
`const port = parseInt(Deno.env.get("PORT") || "0", 10);
Deno.serve({ port, hostname: "127.0.0.1" }, async () => {
    const paths = ${JSON.stringify([denoDir, moduleCacheDir])};
    const results = [];
    for (const p of paths) {
        try {
            await Deno.writeTextFile(p + "/canary_binding_test", "pwned");
            await Deno.remove(p + "/canary_binding_test");
            results.push("WRITE:" + p);
        } catch (e) {
            results.push("BLOCKED:" + p);
        }
    }
    return new Response(results.join("|"));
});
`);

        sys.writeTextFileSync(join(fixtureDir, "main.ts"),
`export default async function(ctx) {
    const res = await ctx.bindings.probewriter.fetch("/");
    const body = await res.text();
    console.log(body);
}
`);

        sys.writeTextFileSync(join(fixtureDir, "webrun.json"), JSON.stringify({
            locations: { default: "main.ts" },
            permissions: {
                storage: { ".": { access: "read" } },
                bindings: ["probewriter"],
            },
            bindings: {
                probewriter: {
                    process: {
                        command: ["deno", "run", "-A", "probe_writer.ts"],
                        portEnv: "PORT",
                    },
                },
            },
        }));

        const cmd = new sys.Command(WEBRUN_BIN, {
            args: ["main.ts"],
            cwd: fixtureDir,
            stdout: "piped",
            stderr: "piped",
        });
        const out = await cmd.output();
        const stdout = new TextDecoder().decode(out.stdout);
        const stderr = new TextDecoder().decode(out.stderr);

        try { sys.removeSync(fixtureDir, { recursive: true }); } catch (_) {}

        if (stdout.includes("WRITE:" + denoDir)) {
            throw new Error(
                "VULNERABILITY: binding wrote to deno binary directory.\n" +
                `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`
            );
        }
        if (stdout.includes("WRITE:" + moduleCacheDir)) {
            throw new Error(
                "VULNERABILITY: binding wrote to shared module cache.\n" +
                `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`
            );
        }

        const blockedCount = (stdout.match(/BLOCKED:/g) || []).length;
        if (blockedCount < 2) {
            throw new Error(
                `Expected 2 blocked paths, got ${blockedCount}.\n` +
                `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`
            );
        }
    });
}

import * as self from "./security_host.test.ts";
registerTests(self);
