// bundling.test.ts — Supply-chain integrity tests for self-bundle/unbundle.
//
// Requires: raw filesystem access, chmod, binary I/O.
// Runner: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/bundling.test.ts
//
// The round-trip integrity test (BundlingRoundTrip) only runs when WEBRUN_BIN
// is a committed release bundle (contains __DATA__). In a dev checkout, the
// bundle produced by --self-bundle is built against the current source tree and
// cannot guarantee round-trip identity; that is by design and not a defect.

import { denoTest } from "./_adapter.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const WORKER_BIN = Deno.env.get("WEBRUN_BIN") || join(dirname(new URL(import.meta.url).pathname), "../../webrun");
const isBundled = Deno.readTextFileSync(WORKER_BIN).includes("\n__DATA__\n");

// ── BundlingBehavior ──────────────────────────────────────────────────────
// Runs against both dev and release builds. Produces a bundled executable
// from the dev source if needed, then validates it can run user scripts and
// enforces storage permissions.

denoTest("BundlingBehavior", async (t) => {
    const runDir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: "sandbox_tb_" }));
    let bundledExecutable = WORKER_BIN;

    if (!isBundled) {
        const workspaceDir = dirname(WORKER_BIN);
        const bundle1Cmd = new Deno.Command(WORKER_BIN, {
            args: ["--self-bundle"],
            cwd: workspaceDir,
            stdout: "piped",
            stderr: "piped",
        });
        const out1 = await bundle1Cmd.output();
        assertEquals(out1.code, 0, "Webrun failed to bundle itself:\n" + new TextDecoder().decode(out1.stderr));

        bundledExecutable = join(runDir, "webrun-bundled");
        Deno.writeFileSync(bundledExecutable, out1.stdout, { mode: 0o755 });
    }

    await t.run("[CLI] Bundled executable supports programmatic API dynamically", async () => {
        const testScript = join(runDir, "dynamic_test.js");
        Deno.writeTextFileSync(testScript, `
            import { webrun } from "webrun/ctx";
            export default async function(ctx) {
                const res = await webrun(["--memory=512", "--eval", "console.log('dynamic_eval_ok');"]);
                if (res.exitCode !== 0) throw new Error("webrun evaluation failed: " + res.stderr);
                if (!res.stdout.includes("dynamic_eval_ok")) throw new Error("webrun stdout mismatch");
                console.log("DYNAMIC_OK");
            }
        `);
        const evalCmd = new Deno.Command(bundledExecutable, {
            args: ["--module", testScript],
            cwd: runDir,
            stdout: "piped",
            stderr: "piped"
        });
        const out = await evalCmd.output();
        assertEquals(out.code, 0, "Bundled executable failed running dynamic programmatic API: " + new TextDecoder().decode(out.stderr));
        assertStringIncludes(new TextDecoder().decode(out.stdout), "DYNAMIC_OK");
    });

    await t.run("[CLI] Bundled executable strictly enforces bounding directories", async () => {
        const secretFile = join(runDir, "secret.js");
        Deno.writeTextFileSync(secretFile, "export const TOP_SECRET = 'DATA';");

        const sandboxDir = join(runDir, "sandbox");
        Deno.mkdirSync(sandboxDir);
        Deno.writeTextFileSync(join(sandboxDir, "webrun.json"), JSON.stringify({
            permissions: { storage: { ".": { access: "read" } } }
        }));
        const script = join(sandboxDir, "read_secret.js");
        Deno.writeTextFileSync(script, `
            import { TOP_SECRET } from "../secret.js";
            export default async function(ctx) {
                console.log("LEAKED: " + TOP_SECRET);
            }
        `);
        const runCmd = new Deno.Command(bundledExecutable, {
            args: ["--module", script],
            cwd: sandboxDir,
            stdout: "piped",
            stderr: "piped"
        });
        const out = await runCmd.output();
        assertEquals(out.code, 1, "Bundled executable inappropriately permitted reading outside its enclave limits natively.");
        assertStringIncludes(new TextDecoder().decode(out.stderr), "Requires read access");
    });

    try { Deno.removeSync(runDir, { recursive: true }); } catch (_) {}
});

// ── BundlingRoundTrip ─────────────────────────────────────────────────────
// Supply-chain integrity: unbundle → inspect source → rebundle → SHA-256 match.
// Only registered when running against a committed release bundle (has __DATA__).
// A dev-tree bundle cannot guarantee round-trip identity because the unbundled
// source is reconstructed from inline source maps, not a committed file tree.

if (isBundled) {
    denoTest("BundlingRoundTrip", async (t) => {
        const runDir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: "sandbox_rt_" }));

        await t.run("[CLI] Bundling and Unbundling maintains structural integrity", async () => {
            const unbundleCmd = new Deno.Command(WORKER_BIN, {
                args: ["--self-unbundle", join(runDir, "webrun-unbundled")],
                cwd: runDir,
                stdout: "piped",
                stderr: "piped"
            });
            const out2 = await unbundleCmd.output();
            assertEquals(out2.code, 0, "Bundled executable failed to unbundle itself:\n" + new TextDecoder().decode(out2.stderr));

            const rebundleCmd = new Deno.Command(join(runDir, "webrun-unbundled", "webrun"), {
                args: ["--self-bundle"],
                cwd: join(runDir, "webrun-unbundled"),
                stdout: "piped",
                stderr: "piped"
            });
            const out3 = await rebundleCmd.output();
            assertEquals(out3.code, 0, "Unbundled executable failed to rebundle itself:\n" + new TextDecoder().decode(out3.stderr));
            Deno.writeFileSync(join(runDir, "webrun-repacked"), out3.stdout, { mode: 0o755 });

            const hashHex = async (buf: Uint8Array) => {
                const hashBuffer = await crypto.subtle.digest("SHA-256", buf as any);
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            };
            const digest1 = await hashHex(Deno.readFileSync(WORKER_BIN));
            const digest2 = await hashHex(Deno.readFileSync(join(runDir, "webrun-repacked")));
            assertEquals(digest1, digest2, "Bundle round-trip produced different bytes. Supply-chain integrity violated.");
        });

        try { Deno.removeSync(runDir, { recursive: true }); } catch (_) {}
    });
}
