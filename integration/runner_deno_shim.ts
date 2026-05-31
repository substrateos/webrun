// Execute a case file under raw Deno with a minimal OPFS shim.

import { assertExitCode, assertOutput, copyDir } from "./runner.ts";
import type { CaseDefinition, DirHandle } from "./suite.ts";

export async function runDenoShimCase(caseDir: DirHandle, def: CaseDefinition, ctx: any): Promise<void> {
    const runDir = ctx.makeTempDir();
    await copyDir(caseDir, runDir);

    const runPath = ctx.resolveHandle(runDir);
    const cwd = def.cwd ? runPath + "/" + def.cwd : runPath;
    const args = def.args || ["main.ts"];
    const fullScript = runPath + "/" + args[0];

    const wrapperPath = runPath + "/__wrapper__.ts";
    ctx.writeTextFileSync(wrapperPath, `
        const cwd = Deno.cwd();
        const dirShim = {
            async getFileHandle(name, opts) {
                const path = cwd + "/" + name;
                if (opts?.create) {
                    await Deno.writeTextFile(path, "");
                } else {
                    await Deno.stat(path);
                }
                return { name };
            }
        };
        const mod = await import(${JSON.stringify("file://" + fullScript)});
        if (typeof mod.default === "function") {
            try { await mod.default({ dir: dirShim }); } catch(e) {
                console.error(e.message);
                Deno.exit(1);
            }
        }
    `);

    const DENO_BIN = ctx.execPath();
    const cmd = new ctx.Command(DENO_BIN, {
        args: ["run", "-A", "--no-lock", "__wrapper__.ts"],
        cwd,
        ...(def.env ? { env: def.env } : {}),
        stdout: "piped",
        stderr: "piped",
    });

    const out = await cmd.output();
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);

    try { ctx.removeSync(runPath, { recursive: true }); } catch (_) { }

    assertExitCode(def.expect!, out.code, stdout, stderr);
    assertOutput(def.expect!, stdout, stderr);
}
