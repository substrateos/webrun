// CLI runner. Spawns webrun as a subprocess.
// Handles batch mode, signal mode, and sequential steps.

import { assertExitCode, assertOutput, extractPort, runHttpProbes, runWsProbes, copyDir, subdir } from "./runner.ts";
import type { CaseDefinition, DirHandle } from "./suite.ts";

/** Run a CLI case: batch, signal, or sequence mode. */
export async function runCliCase(caseDir: DirHandle, def: CaseDefinition, ctx: any): Promise<void> {
    const runDir = ctx.makeTempDir();
    await copyDir(caseDir, runDir);

    const runPath = ctx.resolveHandle(runDir);
    const cwd = def.cwd ? runPath + "/" + def.cwd : runPath;

    // ── Sequence mode: multiple steps sharing one temp dir ──

    if (def.steps) {
        for (let i = 0; i < def.steps.length; i++) {
            const step = def.steps[i];
            const args = step.args || def.args || ["main.ts"];
            const mergedEnv = { ...def.env, ...step.env };
            const hasEnv = Object.keys(mergedEnv).length > 0;

            const bin = step.command === "host" ? args[0] : ctx.WEBRUN_BIN;
            const cmdArgs = step.command === "host" ? args.slice(1) : args;

            const cmd = new ctx.Command(bin, {
                args: cmdArgs,
                cwd,
                ...(hasEnv ? { env: mergedEnv } : {}),
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
        return;
    }

    // ── Signal mode: ready condition + HTTP probes + signal ──

    const args = def.args || (def.signal ? ["--serve", "."] : ["main.ts"]);
    const deadline = def.timeout_ms ?? (def.signal ? 10_000 : undefined);

    const child = new ctx.Command(ctx.WEBRUN_BIN, {
        args,
        cwd,
        ...(def.env ? { env: def.env } : {}),
        stdout: "piped",
        stderr: "piped",
        stdin: "null",
    }).spawn();

    let stdout = "", stderr = "";
    let onChunk: (() => void) | null = null;

    const decoder = new TextDecoder();
    const readStream = async (reader: any, target: "stdout" | "stderr") => {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                if (target === "stdout") stdout += chunk;
                else stderr += chunk;
                if (onChunk) onChunk();
            }
        } catch (_) { }
    };

    const stdoutDone = readStream(child.stdout.getReader(), "stdout");
    const stderrDone = readStream(child.stderr.getReader(), "stderr");

    if (def.expect!.ready || def.signal) {
        if (def.expect!.ready) {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    try { child.kill("SIGKILL"); } catch (_) { }
                    reject(new Error(`Timed out after ${deadline}ms waiting for ready\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
                }, deadline!);

                onChunk = () => {
                    const ready = def.expect!.ready!;
                    const stdoutOk = !ready.stdout || ready.stdout.every(r => !r.contains || stdout.includes(r.contains));
                    const stderrOk = !ready.stderr || ready.stderr.every(r => !r.contains || stderr.includes(r.contains));
                    if (stdoutOk && stderrOk) {
                        clearTimeout(timer);
                        onChunk = null;
                        resolve();
                    }
                };
                onChunk();
            });
        }

        const port = extractPort(stdout);
        if (def.expect!.http && port) {
            await runHttpProbes(port, def.expect!.http);
        }
        if (def.expect!.ws && port) {
            await runWsProbes(port, def.expect!.ws);
        }

        const sig = def.signal || "SIGTERM";
        try { child.kill(sig as any); } catch (_) { }
        const status = await child.status;
        await Promise.all([stdoutDone, stderrDone]);

        try { ctx.removeSync(runPath, { recursive: true }); } catch (_) { }
        assertExitCode(def.expect!, status.code, stdout, stderr);
        assertOutput(def.expect!, stdout, stderr);
        return;
    }

    // ── Batch mode: wait for exit with optional timeout ──

    if (deadline) {
        const timeoutPromise = new Promise<"timeout">(resolve =>
            setTimeout(() => resolve("timeout"), deadline)
        );

        const result = await Promise.race([
            Promise.all([child.status, stdoutDone, stderrDone])
                .then(([status]) => ({ kind: "done" as const, status })),
            timeoutPromise,
        ]);

        if (result === "timeout") {
            try { child.kill("SIGKILL"); } catch {}
            await new Promise(r => setTimeout(r, 200));
            try { ctx.removeSync(runPath, { recursive: true }); } catch {}
            throw new Error(`Test timed out after ${deadline}ms\nstdout: ${stdout}\nstderr: ${stderr}`);
        }

        const { status } = result;
        try { ctx.removeSync(runPath, { recursive: true }); } catch {}
        assertExitCode(def.expect!, status.code, stdout, stderr);
        assertOutput(def.expect!, stdout, stderr);
    } else {
        const [status] = await Promise.all([child.status, stdoutDone, stderrDone]);
        try { ctx.removeSync(runPath, { recursive: true }); } catch {}
        assertExitCode(def.expect!, status.code, stdout, stderr);
        assertOutput(def.expect!, stdout, stderr);
    }
}

