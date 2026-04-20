import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { runBatchCase } from "./case_runner.ts";
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
        await t.run(`[webrun] ${def.name}`, async () => {
            // Map expect_webrun → expect for runBatchCase.
            await runBatchCase(t, dir, { ...def, expect: def.expect_webrun });
        });
    }
}
