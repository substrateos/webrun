// Worker runner. Executes via Context API (ctx.run).
// Handles both batch mode (no signal) and signal mode (ready + probes + signal).

import { assertExitCode, assertOutput, extractPort, runHttpProbes, copyDir, subdir } from "./runner.ts";
import type { CaseDefinition, DirHandle } from "./suite.ts";
import type { Context } from "../src/core/types.ts";

/** Wrap ctx.run: on throw, return a synthetic handle with exit code 1 + error on stderr. */
async function tryRun(ctx: Context, args: string[], options: Parameters<Context["run"]>[1]): ReturnType<Context["run"]> {
    try {
        return await ctx.run(args, options);
    } catch (err: any) {
        const msg = err?.message || String(err);
        const enc = new TextEncoder();
        return {
            exitCode: Promise.resolve(1),
            stdout: new ReadableStream({ start(c) { c.close(); } }),
            stderr: new ReadableStream({ start(c) { c.enqueue(enc.encode(msg + "\n")); c.close(); } }),
            signal() { },
        } as any;
    }
}

/** Run a worker case: batch or signal mode, determined by the case definition. */
export default async function runWorkerCase(caseDir: DirHandle, def: CaseDefinition, ctx: Context): Promise<void> {
    const runDir = await ctx.makeTempDir();

    // Only write a baseline when the case has a webrun.json.
    // Cases without config test the "no config" scenario.
    const caseCfg = await readCaseConfig(caseDir);
    if (caseCfg) {
        // Always grant read to case/ for script loading.
        // Remap case storage entries on top for precise access grants.
        const baselineStorage: Record<string, { access: string }> = { "case": { access: "read" } };
        if (caseCfg.permissions?.storage) {
            for (const [path, access] of Object.entries(caseCfg.permissions.storage)) {
                if (path.includes("..")) continue;
                const remapped = path === "." ? "case" : `case/${path}`;
                baselineStorage[remapped] = access as { access: string };
            }
        }
        const baselineConfig = JSON.stringify({
            permissions: {
                storage: baselineStorage,
                ...(caseCfg.permissions?.network ? { network: ["*"] } : {}),
                ...(caseCfg.permissions?.env ? { env: ["*"] } : {}),
                ...(caseCfg.permissions?.import ? { import: ["*"] } : {}),
                ...(caseCfg.permissions?.gpu ? { gpu: true } : {}),
                ...(caseCfg.permissions?.webrtc ? { webrtc: true } : {}),
                ...(caseCfg.permissions?.delegate ? { delegate: caseCfg.permissions.delegate } : {}),
            },
            ...(caseCfg.limits ? { limits: { timeoutMillis: 120000, memoryMB: 4096 } } : {}),
            ...(caseCfg.isolate ? { isolate: caseCfg.isolate.map((p: string) => `case/${p}`) } : {}),
        });
        const baselineHandle = await runDir.getFileHandle("webrun.json", { create: true });
        const baselineWriter = await baselineHandle.createWritable();
        await baselineWriter.write(baselineConfig);
        await baselineWriter.close();
    }

    const caseRoot = await runDir.getDirectoryHandle("case", { create: true });
    await copyDir(caseDir, caseRoot);

    // In production, a parent calling ctx.run ensures the child can load its entry script.
    // Inject minimum storage when the child's config has no `permissions` field (permissive mode).
    // If the child has `permissions` (even empty), it opted into restricted mode — respect it.
    if (caseCfg && !("permissions" in caseCfg)) {
        const childConfig = { ...caseCfg, permissions: { storage: { ".": { access: "read" } } } };
        const childHandle = await caseRoot.getFileHandle("webrun.json", { create: true });
        const childWriter = await childHandle.createWritable();
        await childWriter.write(JSON.stringify(childConfig));
        await childWriter.close();
    }

    const dir = def.cwd ? await subdir(caseRoot, def.cwd) : caseRoot;

    // ── Signal mode: streaming output + ready + probes + signal ──

    if (def.expect!.ready || def.signal) {
        const args = def.args || ["--serve", "."];
        const deadline = def.timeout_ms ?? 10_000;

        const controller = new AbortController();

        const handle = await tryRun(ctx, args, {
            dir,
            env: def.env,
            signal: controller.signal,
            limits: { timeoutMillis: deadline + 5_000 },
        });

        // Accumulate stdout/stderr from the live ReadableStreams.
        let stdout = "", stderr = "";
        let onChunk: (() => void) | null = null;

        const decoder = new TextDecoder();

        const pumpStream = async (stream: ReadableStream<Uint8Array>, target: "stdout" | "stderr") => {
            const reader = stream.getReader();
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    const text = decoder.decode(value, { stream: true });
                    if (target === "stdout") stdout += text;
                    else stderr += text;
                    if (onChunk) onChunk();
                }
            } finally {
                reader.releaseLock();
            }
        };

        // Start pumping both streams concurrently.
        const stdoutDone = pumpStream(handle.stdout, "stdout");
        const stderrDone = pumpStream(handle.stderr, "stderr");

        // Wait for ready condition.
        if (def.expect!.ready) {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    controller.abort();
                    reject(new Error(`Timed out after ${deadline}ms waiting for ready\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
                }, deadline);

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

        // HTTP probes.
        const port = extractPort(stdout);
        if (def.expect!.http && port) {
            await runHttpProbes(port, def.expect!.http);
        }

        // Signal the process to stop and wait for exit.
        controller.abort(def.signal || "SIGTERM");
        const exitCode = await handle.exitCode;
        await Promise.all([stdoutDone, stderrDone]);

        assertExitCode(def.expect!, exitCode, stdout, stderr);
        assertOutput(def.expect!, stdout, stderr);
        return;
    }

    // ── Batch mode: run to completion ──

    const args = def.args || ["main.ts"];

    const handle = await tryRun(ctx, args, {
        dir,
        env: def.env,
        limits: { timeoutMillis: def.timeout_ms ?? 30_000 },
    });

    const [exitCode, stdout, stderr] = await Promise.all([
        handle.exitCode,
        new Response(handle.stdout).text(),
        new Response(handle.stderr).text(),
    ]);

    assertExitCode(def.expect!, exitCode, stdout, stderr);
    assertOutput(def.expect!, stdout, stderr);
}

// ── Baseline generation ──────────────────────────────────────────────────────

/** Read the case's top-level webrun.json. Returns null if absent or malformed. */
async function readCaseConfig(dir: DirHandle): Promise<any | null> {
    try {
        const fh = await dir.getFileHandle("webrun.json");
        const file = await fh.getFile();
        return JSON.parse(await file.text());
    } catch { return null; }
}

