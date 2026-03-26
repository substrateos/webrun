import { runTests } from "./framework.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

export async function testBundlingStructuralIntegrity(tc: any) {
    const Deno = tc.Deno;
    const WORKER_BIN = tc.WORKER_BIN;

    if (tc.IS_REPACKED_TEST) return;

    await tc.run("[CLI] Bundling and Unbundling maintains structural integrity", async () => {
        const runDir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: "sandbox_tb_" }));

        const isBundled = Deno.readTextFileSync(WORKER_BIN).includes("\n__DATA__\n");
        let bundledExecutable = WORKER_BIN;

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

        try { Deno.removeSync(runDir, { recursive: true }); } catch (_) { }
    });
}

