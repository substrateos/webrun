// bundling.test.ts — Supply-chain integrity tests for self-bundle/unbundle.
//
// Requires: raw filesystem access, chmod, binary I/O.
// Runner: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/bundling.test.ts
//
// The round-trip integrity test (BundlingRoundTrip) only runs when WEBRUN_BIN
// is a committed release bundle (contains __DATA__). In a dev checkout, the
// bundle produced by --self-bundle is built against the current source tree and
// cannot guarantee round-trip identity; that is by design and not a defect.

import { registerTests, sys } from "./_adapter.ts";
import { WEBRUN_BIN } from "./_cli_runner.ts";
import { dirname, join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
const isBundled = sys.readTextFileSync(WEBRUN_BIN).includes("\n__DATA__\n");

// ── BundlingBehavior ──────────────────────────────────────────────────────
// Runs against both dev and release builds. Produces a bundled executable
// from the dev source if needed, then validates it can run user scripts and
// enforces storage permissions.

export async function testBundlingBehavior(t: any) {
    const runDir = sys.realPathSync(sys.makeTempDirSync({ prefix: "sandbox_tb_" }));
    let bundledExecutable = WEBRUN_BIN;

    if (!isBundled) {
        const workspaceDir = dirname(WEBRUN_BIN);
        const bundle1Cmd = new sys.Command(WEBRUN_BIN, {
            args: ["--self-bundle"],
            cwd: workspaceDir,
            stdout: "piped",
            stderr: "piped",
        });
        const out1 = await bundle1Cmd.output();
        assertEquals(out1.code, 0, "Webrun failed to bundle itself:\n" + new TextDecoder().decode(out1.stderr));

        bundledExecutable = join(runDir, "webrun-bundled");
        sys.writeFileSync(bundledExecutable, out1.stdout, { mode: 0o755 });
    }

    await t.run("[CLI] Bundled executable supports programmatic API dynamically", async () => {
        const testScript = join(runDir, "dynamic_test.js");
        sys.writeTextFileSync(testScript, `
            import { webrun } from "webrun/ctx";
            export default async function(ctx) {
                const res = await webrun(["--memory=512", "--eval", "console.log('dynamic_eval_ok');"]);
                if (res.exitCode !== 0) throw new Error("webrun evaluation failed: " + res.stderr);
                if (!res.stdout.includes("dynamic_eval_ok")) throw new Error("webrun stdout mismatch");
                console.log("DYNAMIC_OK");
            }
        `);
        const evalCmd = new sys.Command(bundledExecutable, {
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
        sys.writeTextFileSync(secretFile, "export const TOP_SECRET = 'DATA';");

        const sandboxDir = join(runDir, "sandbox");
        sys.mkdirSync(sandboxDir);
        sys.writeTextFileSync(join(sandboxDir, "webrun.json"), JSON.stringify({
            permissions: { storage: { ".": { access: "read" } } }
        }));
        const script = join(sandboxDir, "read_secret.js");
        sys.writeTextFileSync(script, `
            import { TOP_SECRET } from "../secret.js";
            export default async function(ctx) {
                console.log("LEAKED: " + TOP_SECRET);
            }
        `);
        const runCmd = new sys.Command(bundledExecutable, {
            args: ["--module", script],
            cwd: sandboxDir,
            stdout: "piped",
            stderr: "piped"
        });
        const out = await runCmd.output();
        assertEquals(out.code, 1, "Bundled executable inappropriately permitted reading outside its enclave limits natively.");
        assertStringIncludes(new TextDecoder().decode(out.stderr), "Requires read access");
    });

    try { sys.removeSync(runDir, { recursive: true }); } catch (_) {}
}

// ── BundlingRoundTrip ─────────────────────────────────────────────────────
// Supply-chain integrity: unbundle → inspect source → rebundle → SHA-256 match.
// Only registered when running against a committed release bundle (has __DATA__).
// A dev-tree bundle cannot guarantee round-trip identity because the unbundled
// source is reconstructed from inline source maps, not a committed file tree.

export async function testBundlingRoundTrip(t: any) {
    const runDir = sys.realPathSync(sys.makeTempDirSync({ prefix: "sandbox_rt_" }));

    await t.run("[CLI] Bundling and Unbundling maintains structural integrity", async () => {
        const unbundleCmd = new sys.Command(WEBRUN_BIN, {
            args: ["--self-unbundle", join(runDir, "webrun-unbundled")],
            cwd: runDir,
            stdout: "piped",
            stderr: "piped"
        });
        const out2 = await unbundleCmd.output();
        assertEquals(out2.code, 0, "Bundled executable failed to unbundle itself:\n" + new TextDecoder().decode(out2.stderr));

        const rebundleCmd = new sys.Command(join(runDir, "webrun-unbundled", "webrun"), {
            args: ["--self-bundle"],
            cwd: join(runDir, "webrun-unbundled"),
            stdout: "piped",
            stderr: "piped"
        });
        const out3 = await rebundleCmd.output();
        assertEquals(out3.code, 0, "Unbundled executable failed to rebundle itself:\n" + new TextDecoder().decode(out3.stderr));
        sys.writeFileSync(join(runDir, "webrun-repacked"), out3.stdout, { mode: 0o755 });

        const hashHex = async (buf: Uint8Array) => {
            const hashBuffer = await crypto.subtle.digest("SHA-256", buf as any);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        };
        const digest1 = await hashHex(sys.readFileSync(WEBRUN_BIN));
        const digest2 = await hashHex(sys.readFileSync(join(runDir, "webrun-repacked")));
        assertEquals(digest1, digest2, "Bundle round-trip produced different bytes. Supply-chain integrity violated.");
    });

    try { sys.removeSync(runDir, { recursive: true }); } catch (_) {}
}

import * as self from "./bundling.test.ts";
const toRegister: Record<string, unknown> = { testBundlingBehavior: self.testBundlingBehavior };
if (isBundled) toRegister.testBundlingRoundTrip = self.testBundlingRoundTrip;
registerTests(toRegister);
