// security_host.test.ts — External security regression tests.
//
// These tests spawn real webrun processes and observe behavior.
// Run via: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/security_host.test.ts

import { registerTests, sys } from "./_adapter.ts";
import { WEBRUN_BIN, copyDirRecursive } from "./_cli_runner.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

export async function testSecurityHost(t: any) {
    // ── M1: import map sinkhole override via user importMap ──────────────
    //
    // A webrun.json with importMap pointing to a user map that overrides
    // node:path should NOT succeed — the sinkhole must take precedence.

    await t.run("M1: user import map cannot override node:path sinkhole", async () => {
        const fixtureDir = sys.realPathSync(sys.makeTempDirSync({ prefix: "m1_" }));

        // User import map that tries to override node:path.
        sys.writeTextFileSync(join(fixtureDir, "custom_map.json"), JSON.stringify({
            imports: {
                "node:path": "./my_path.ts",
            }
        }));

        // Custom module that exports a canary function.
        sys.writeTextFileSync(join(fixtureDir, "my_path.ts"),
`export function join(...args) { return "OVERRIDDEN:" + args.join("/"); }
`);

        // Main script that imports node:path and checks which module loaded.
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
            module: "main.ts",
            importMap: "custom_map.json",
            permissions: {
                storage: { ".": { access: "read" } },
            }
        }));

        const cmd = new sys.Command(WEBRUN_BIN, {
            args: ["--module", "main.ts"],
            cwd: fixtureDir,
            stdout: "piped",
            stderr: "piped",
        });
        const out = await cmd.output();
        const stdout = new TextDecoder().decode(out.stdout);
        const stderr = new TextDecoder().decode(out.stderr);

        try { sys.removeSync(fixtureDir, { recursive: true }); } catch (_) {}

        // The sinkhole should be active — node:path must throw or return
        // the sinkhole module, NOT the user's override.
        if (stdout.includes("SINKHOLE_BYPASSED")) {
            throw new Error(
                "VULNERABILITY CONFIRMED: user import map overrode node:path sinkhole.\n" +
                `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`
            );
        }

        // Accept either SINKHOLE_THREW or SINKHOLE_ACTIVE as correct behavior.
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

    // NOTE: F1 (self-test jail bypass) is tested as a unit test in security.test.ts
    // because the seatbelt is defense-in-depth beneath global scrubbing — the guest
    // cannot observe whether the OS jail is active. The unit test asserts that
    // CommandInvocation carries isSelfTest so the jail OS decision uses a trusted signal.

    // ── F3: Binding process without permissions.env must not see host secrets ─
    //
    // A binding whose processConfig omits permissions.env should get only the
    // restricted base env. Host secrets must not leak through.

    await t.run("F3: binding without permissions.env does not receive host secrets", async () => {
        const fixtureDir = sys.realPathSync(sys.makeTempDirSync({ prefix: "f3_" }));

        // Backend: a Deno HTTP server that echoes its full environment.
        sys.writeTextFileSync(join(fixtureDir, "env_echo.ts"),
`const port = parseInt(Deno.env.get("PORT") || "0", 10);
Deno.serve({ port, hostname: "127.0.0.1" }, () => {
    return new Response(JSON.stringify(Deno.env.toObject()));
});
`);

        // Guest script: calls the binding and checks for leaked host vars.
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

        // Binding config WITHOUT permissions.env — the vulnerable case.
        sys.writeTextFileSync(join(fixtureDir, "webrun.json"), JSON.stringify({
            module: "main.ts",
            permissions: {
                storage: { ".": { access: "read" } },
                bindings: ["echoenv"],
            },
            bindings: {
                echoenv: {
                    process: {
                        command: ["deno", "run", "-A", "env_echo.ts"],
                        portEnv: "PORT",
                        // No permissions.env here — this is the vulnerability.
                    },
                },
            },
        }));

        const cmd = new sys.Command(WEBRUN_BIN, {
            args: ["--module", "main.ts"],
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

        // Also ensure the test actually ran (didn't silently skip).
        if (!stdout.includes("ENV_RESTRICTED_OK") && !stdout.includes("ENV_LEAKED:")) {
            throw new Error(
                `Test script did not produce expected output.\n` +
                `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`
            );
        }
    });
}

import * as self from "./security_host.test.ts";
registerTests(self);
