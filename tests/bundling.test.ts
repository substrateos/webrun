import { runTests } from "./framework.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

export async function testBundlingBehavior(tc: any) {
    const Deno = tc.Deno;
    const WORKER_BIN = tc.WORKER_BIN;

    if (tc.IS_REPACKED_TEST) return;

    const runDir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: "sandbox_tb_" }));
    let bundledExecutable = WORKER_BIN;

    const isBundled = Deno.readTextFileSync(WORKER_BIN).includes("\n__DATA__\n");
    if (!isBundled) {
        const workspaceDir = dirname(WORKER_BIN);
        const bundle1Cmd = new Deno.Command(WORKER_BIN, {
            args: ["--self-bundle"],
            cwd: workspaceDir,
            stdout: "piped"
        });
        const bundle1Output = await bundle1Cmd.output();
        assertEquals(bundle1Output.code, 0);
        Deno.writeFileSync(join(runDir, "first_bundle"), bundle1Output.stdout);
        Deno.chmodSync(join(runDir, "first_bundle"), 0o755);
        bundledExecutable = join(runDir, "first_bundle");
    }

    await tc.run("[CLI] Bundling and Unbundling maintains structural integrity", async () => {
        const unbundleCmd = new Deno.Command(bundledExecutable, {
            args: ["--self-unbundle", join(runDir, "src_out")],
        });
        const unbundleOutput = await unbundleCmd.output();
        assertEquals(unbundleOutput.code, 0);

        const bundle2Cmd = new Deno.Command(join(runDir, "src_out", "webrun"), {
            args: ["--self-bundle"],
            cwd: join(runDir, "src_out"),
            stdout: "piped"
        });
        const bundleOutput = await bundle2Cmd.output();
        if (bundleOutput.code !== 0) {
            console.error("BUNDLE FAILED:", new TextDecoder().decode(bundleOutput.stderr));
        }
        assertEquals(bundleOutput.code, 0);
        Deno.writeFileSync(join(runDir, "webrun-repacked"), bundleOutput.stdout);
        Deno.chmodSync(join(runDir, "webrun-repacked"), 0o755);

        const hashHex = async (buf: Uint8Array) => {
            const hashBuffer = await crypto.subtle.digest("SHA-256", buf as any);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        };
        const digest1 = await hashHex(Deno.readFileSync(bundledExecutable));
        const digest2 = await hashHex(Deno.readFileSync(join(runDir, "webrun-repacked")));
        assertEquals(digest1, digest2, "Bundled executables do not match in content digest! Determinism failed.");
    });

    await tc.run("[CLI] Bundled executable supports programmatic API dynamically", async () => {
        const testScript = join(runDir, "dynamic_test.js");
        Deno.writeTextFileSync(testScript, `
            import { webrun } from "webrun/ctx";
            export default async function(ctx) {
                const res = await webrun(["--eval", "console.log('dynamic_eval_ok');"]);
                if (res.exitCode !== 0) throw new Error("webrun evaluation failed: " + res.stderr);
                if (!res.stdout.includes("dynamic_eval_ok")) throw new Error("webrun stdout mismatch");
                console.log("DYNAMIC_OK");
            }
        `);
        const evalCmd = new Deno.Command(bundledExecutable, {
            args: [testScript],
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
            args: [script],
            cwd: sandboxDir,
            stdout: "piped",
            stderr: "piped"
        });
        const out = await runCmd.output();
        assertEquals(out.code, 1, "Bundled executable inappropriately permitted reading outside its enclave limits natively.");
        assertStringIncludes(new TextDecoder().decode(out.stderr), "Requires read access");
    });

    try { Deno.removeSync(runDir, { recursive: true }); } catch (_) { }
}

