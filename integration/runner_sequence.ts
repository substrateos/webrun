// Execute a sequence of stateful commands inside the same temporary sandbox directory.

import { assertExitCode, assertOutput, copyDir } from "./cases.ts";
import type { CaseDefinition, DirHandle } from "./cases.ts";

export async function runSequenceCase(caseDir: DirHandle, def: CaseDefinition, ctx: any): Promise<void> {
    const runDir = ctx.makeTempDir();
    await copyDir(caseDir, runDir);

    const runPath = ctx.resolveHandle(runDir);
    const cwd = def.cwd ? runPath + "/" + def.cwd : runPath;

    for (let i = 0; i < (def.steps || []).length; i++) {
        const step = def.steps![i];
        const args = step.args || def.args || ["main.ts"];
        const env = { ...def.env, ...step.env };

        const bin = step.command === "host" ? args[0] : ctx.WEBRUN_BIN;
        const cmdArgs = step.command === "host" ? args.slice(1) : args;

        const cmd = new ctx.Command(bin, {
            args: cmdArgs,
            cwd,
            env,
            stdout: "piped",
            stderr: "piped",
        });

        const out = await cmd.output();
        const stdout = new TextDecoder().decode(out.stdout);
        const stderr = new TextDecoder().decode(out.stderr);

        try {
            assertExitCode(step.expect, out.code, stdout, stderr);
            assertOutput(step.expect, stdout, stderr);
        } catch (e) {
            try { ctx.removeSync(runPath, { recursive: true }); } catch (_) { }
            throw new Error(`Step ${i + 1} (${args.join(" ")}) failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    try { ctx.removeSync(runPath, { recursive: true }); } catch (_) { }
}
