import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

export async function testBundlingBehavior(tc: any) {
    const testsys = tc.testsys;
    const WORKER_BIN = tc.WORKER_BIN;

    if (tc.IS_REPACKED_TEST) return;

    const runDir = testsys.realPathSync(testsys.makeTempDirSync({ prefix: "sandbox_tb_" }));
    let bundledExecutable = WORKER_BIN;

    const isBundled = testsys.readTextFileSync(WORKER_BIN).includes("\n__DATA__\n");
    if (!isBundled) {
        const workspaceDir = dirname(WORKER_BIN);
        const bundle1Cmd = new testsys.Command(WORKER_BIN, {
            args: ["--self-bundle"],
            cwd: workspaceDir,
            stdout: "piped"
        });
        const out1 = await bundle1Cmd.output();
        assertEquals(out1.code, 0, "Webrun failed to bundle itself explicitly.");
        
        bundledExecutable = join(runDir, "webrun-bundled");
        testsys.writeFileSync(bundledExecutable, out1.stdout, { mode: 0o755 });
    }

    await tc.run("[CLI] Bundling and Unbundling maintains structural integrity", async () => {
        const unbundleCmd = new testsys.Command(bundledExecutable, {
            args: ["--self-unbundle", join(runDir, "webrun-unbundled")],
            cwd: runDir,
            stdout: "piped",
            stderr: "piped"
        });
        const out2 = await unbundleCmd.output();
        assertEquals(out2.code, 0, "Bundled executable failed to unbundle itself.");

        const rebundleCmd = new testsys.Command(join(runDir, "webrun-unbundled", "webrun"), {
            args: ["--self-bundle"],
            cwd: join(runDir, "webrun-unbundled"),
            stdout: "piped",
            stderr: "piped"
        });
        const out3 = await rebundleCmd.output();
        if (out3.code !== 0) console.error("Rebundle failed:", new TextDecoder().decode(out3.stderr));
        assertEquals(out3.code, 0, "Unbundled executable failed to rebundle itself.");
        testsys.writeFileSync(join(runDir, "webrun-repacked"), out3.stdout, { mode: 0o755 });

        // Supply-chain integrity: the rebundled executable must be byte-identical
        // to the original. This guarantees that unbundling + inspecting source +
        // rebundling produces a cryptographically verifiable match, proving the
        // inspected source is exactly what the executable runs.
        const hashHex = async (buf: Uint8Array) => {
            const hashBuffer = await crypto.subtle.digest("SHA-256", buf as any);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        };
        const digest1 = await hashHex(testsys.readFileSync(bundledExecutable));
        const digest2 = await hashHex(testsys.readFileSync(join(runDir, "webrun-repacked")));
        assertEquals(digest1, digest2, "Bundle round-trip produced different bytes. Supply-chain integrity violated.");
    });

    await tc.run("[CLI] Bundled executable supports programmatic API dynamically", async () => {
        const testScript = join(runDir, "dynamic_test.js");
        testsys.writeTextFileSync(testScript, `
            import { webrun } from "webrun/ctx";
            export default async function(ctx) {
                const res = await webrun(["--memory=512", "--eval", "console.log('dynamic_eval_ok');"]);
                if (res.exitCode !== 0) throw new Error("webrun evaluation failed: " + res.stderr);
                if (!res.stdout.includes("dynamic_eval_ok")) throw new Error("webrun stdout mismatch");
                console.log("DYNAMIC_OK");
            }
        `);
        const evalCmd = new testsys.Command(bundledExecutable, {
            args: ["--module", testScript],
            cwd: runDir,
            stdout: "piped",
            stderr: "piped"
        });
        const out = await evalCmd.output();
        assertEquals(out.code, 0, "Bundled executable failed running dynamic programmatic API: " + new TextDecoder().decode(out.stderr));
        assertStringIncludes(new TextDecoder().decode(out.stdout), "DYNAMIC_OK");
    });

    await tc.run("[CLI] Bundled executable strictly enforces bounding directories", async () => {
        const secretFile = join(runDir, "secret.js");
        testsys.writeTextFileSync(secretFile, "export const TOP_SECRET = 'DATA';");
        
        const sandboxDir = join(runDir, "sandbox");
        testsys.mkdirSync(sandboxDir);
        testsys.writeTextFileSync(join(sandboxDir, "webrun.json"), JSON.stringify({
            permissions: { storage: { ".": { access: "read" } } }
        }));
        const script = join(sandboxDir, "read_secret.js");
        testsys.writeTextFileSync(script, `
            import { TOP_SECRET } from "../secret.js";
            export default async function(ctx) {
                console.log("LEAKED: " + TOP_SECRET);
            }
        `);
        const runCmd = new testsys.Command(bundledExecutable, {
            args: ["--module", script],
            cwd: sandboxDir,
            stdout: "piped",
            stderr: "piped"
        });
        const out = await runCmd.output();
        assertEquals(out.code, 1, "Bundled executable inappropriately permitted reading outside its enclave limits natively.");
        assertStringIncludes(new TextDecoder().decode(out.stderr), "Requires read access");
    });

    try { testsys.removeSync(runDir, { recursive: true }); } catch (e) { }
}
