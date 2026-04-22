// globals_deno.test.ts — Raw host-runtime pass for globals test cases.
//
// Verifies that the same scripts produce equivalent behavior under the raw
// host runtime as they do under the webrun sandbox. The webrun pass is in
// globals_webrun.test.ts.

import { registerTests, sys } from "./_adapter.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import type { CaseExpect } from "./_cli_runner.ts";

interface GlobalsCaseDefinition {
    name: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    expect_webrun: CaseExpect;
    expect_deno: CaseExpect;
}

function discoverGlobalsCases(rootDir: string): { dir: string; def: GlobalsCaseDefinition }[] {
    const cases: { dir: string; def: GlobalsCaseDefinition }[] = [];
    let entries: Iterable<{ name: string; isDirectory: boolean }>;
    try { entries = sys.readDirSync(rootDir); } catch { return cases; }
    for (const entry of entries) {
        if (!entry.isDirectory) continue;
        const caseDir = join(rootDir, entry.name);
        try {
            const raw = sys.readTextFileSync(join(caseDir, "cases.json"));
            const defs: GlobalsCaseDefinition[] = JSON.parse(raw);
            for (const def of defs) cases.push({ dir: caseDir, def });
        } catch {
            cases.push(...discoverGlobalsCases(caseDir));
        }
    }
    return cases;
}

function copyDirRecursive(src: string, dest: string): void {
    sys.mkdirSync(dest, { recursive: true });
    for (const entry of sys.readDirSync(src)) {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);
        if (entry.isDirectory) {
            copyDirRecursive(srcPath, destPath);
        } else {
            sys.copyFileSync(srcPath, destPath);
        }
    }
}

export async function testGlobalsDeno(t: any) {
    const thisDir = dirname(new URL(import.meta.url).pathname);
    const cases = discoverGlobalsCases(join(thisDir, "..", "globals"));
    if (cases.length === 0) throw new Error("No globals test cases discovered");

    for (const { dir, def } of cases) {
        await t.run(`[deno] ${def.name}`, async () => {
            const runDir = sys.realPathSync(sys.makeTempDirSync({ prefix: "gbl_" }));
            copyDirRecursive(dir, runDir);

            const args = def.args || ["--module", "main.ts"];
            const scriptPath = args[args.length - 1];
            const cwd = def.cwd ? join(runDir, def.cwd) : runDir;
            const fullScript = join(cwd, scriptPath);

            // This wrapper script runs under the raw host runtime to simulate
            // a minimal OPFS-like environment for the test scripts.
            const wrapperPath = join(runDir, "__wrapper__.ts");
            sys.writeTextFileSync(wrapperPath, `
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

            const proc = new sys.Command(sys.execPath(), {
                args: ["run", "-A", wrapperPath],
                cwd,
                env: def.env,
                stdout: "piped",
                stderr: "piped",
            }).spawn();

            const decoder = new TextDecoder();
            let stdout = "", stderr = "";

            const readStream = async (stream: ReadableStream<Uint8Array>, isStdout: boolean) => {
                const reader = stream.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (isStdout) stdout += decoder.decode(value);
                        else stderr += decoder.decode(value);
                    }
                } catch (_) {}
            };

            const timer = setTimeout(() => {
                try { proc.kill("SIGTERM"); } catch (_) {}
            }, 30_000);

            const [status] = await Promise.all([
                proc.status,
                readStream(proc.stdout!, true),
                readStream(proc.stderr!, false),
            ]);

            clearTimeout(timer);
            try { sys.removeSync(runDir, { recursive: true }); } catch (_) {}

            const expect = def.expect_deno;
            const combined = stdout + "\n" + stderr;

            if (expect.exit_code === "nonzero") {
                if (status.code === 0) throw new Error(`[deno] Expected nonzero exit code, got 0\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
            } else if (typeof expect.exit_code === "number") {
                if (status.code !== expect.exit_code) throw new Error(`[deno] Expected exit code ${expect.exit_code}, got ${status.code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
            }

            for (const rule of expect.stdout || []) {
                if (rule.contains && !combined.includes(rule.contains)) {
                    throw new Error(`[deno] Expected stdout to contain "${rule.contains}"\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
                }
            }
            for (const rule of expect.stderr || []) {
                if (rule.contains && !combined.includes(rule.contains)) {
                    throw new Error(`[deno] Expected stderr to contain "${rule.contains}"\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
                }
            }
        });
    }
}

import * as self from "./globals_deno.test.ts";
registerTests(self);
