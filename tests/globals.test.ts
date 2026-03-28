import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { discoverCases, runBatchCase, copyDirRecursive } from "./case_runner.ts";
import type { CaseExpect } from "./case_runner.ts";

interface GlobalsCaseDefinition {
    name: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    expect_webrun: CaseExpect;
    expect_deno: CaseExpect;
}

function discoverGlobalsCases(t: any, rootDir: string): { dir: string; def: GlobalsCaseDefinition }[] {
    const cases: { dir: string; def: GlobalsCaseDefinition }[] = [];
    let entries: any[];
    try { entries = [...t.testsys.readDirSync(rootDir)]; } catch { return cases; }
    for (const entry of entries) {
        if (!entry.isDirectory) continue;
        const caseDir = join(rootDir, entry.name);
        try {
            const raw = t.testsys.readTextFileSync(join(caseDir, "cases.json"));
            const defs: GlobalsCaseDefinition[] = JSON.parse(raw);
            for (const def of defs) cases.push({ dir: caseDir, def });
        } catch {
            cases.push(...discoverGlobalsCases(t, caseDir));
        }
    }
    return cases;
}

export async function testGlobals(t: any) {
    const thisDir = dirname(new URL(import.meta.url).pathname);
    const cases = discoverGlobalsCases(t, join(thisDir, "globals"));
    if (cases.length === 0) throw new Error("No globals test cases discovered");

    for (const { dir, def } of cases) {
        // WebRun pass: run through webrun using standard batch runner.
        const webrunDef = { ...def, expect: def.expect_webrun };
        await t.run(`[webrun] ${def.name}`, async () => {
            await runBatchCase(t, dir, webrunDef);
        });

        // Raw Deno pass: run directly with deno run -A.
        await t.run(`[deno] ${def.name}`, async () => {
            const runDir = t.testsys.realPathSync(t.testsys.makeTempDirSync({ prefix: "gbl_" }));
            copyDirRecursive(t, dir, runDir);

            const args = def.args || ["--module", "main.ts"];
            // Extract the script path from args: find the last arg (the script file).
            const scriptPath = args[args.length - 1];
            const cwd = def.cwd ? join(runDir, def.cwd) : runDir;
            const fullScript = join(cwd, scriptPath);

            // Create a wrapper that imports the module and invokes its default export,
            // mimicking what webrun's --module flag does. Provides a minimal ctx.dir
            // shim so payloads using OPFS-style APIs can run under raw Deno.
            const wrapperPath = join(runDir, "__deno_wrapper__.ts");
            t.testsys.writeTextFileSync(wrapperPath, `
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

            const proc = new t.testsys.Command(t.testsys.execPath(), {
                args: ["run", "-A", wrapperPath],
                cwd,
                env: def.env,
                stdout: "piped",
                stderr: "piped",
            }).spawn();

            const decoder = new TextDecoder();
            let stdout = "", stderr = "";

            const readStream = async (stream: any, isStdout: boolean) => {
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
                readStream(proc.stdout, true),
                readStream(proc.stderr, false),
            ]);

            clearTimeout(timer);
            try { t.testsys.removeSync(runDir, { recursive: true }); } catch (_) {}

            const expect = def.expect_deno;
            const combined = stdout + "\n" + stderr;

            // Assert exit code.
            if (expect.exit_code === "nonzero") {
                if (status.code === 0) throw new Error(`[deno] Expected nonzero exit code, got 0\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
            } else if (typeof expect.exit_code === "number") {
                if (status.code !== expect.exit_code) throw new Error(`[deno] Expected exit code ${expect.exit_code}, got ${status.code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
            }

            // Assert output.
            for (const rule of expect.stdout || []) {
                if (!combined.includes(rule.contains)) {
                    throw new Error(`[deno] Expected stdout to contain "${rule.contains}"\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
                }
            }
            for (const rule of expect.stderr || []) {
                if (!combined.includes(rule.contains)) {
                    throw new Error(`[deno] Expected stderr to contain "${rule.contains}"\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
                }
            }
        });
    }
}
