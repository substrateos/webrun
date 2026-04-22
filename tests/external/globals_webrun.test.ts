// globals_webrun.test.ts — Global scrubbing tests via the full host pipeline.
//
// The webrun pass: runs each globals test case through the webrun binary and
// asserts against expect_webrun. The deno pass is in globals_deno.test.ts.
//
// Runner: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/globals_webrun.test.ts

import { registerTests, sys } from "./_adapter.ts";
import { runCliCase, copyDirRecursive, WEBRUN_BIN } from "./_cli_runner.ts";
import type { CaseExpect } from "./_cli_runner.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

const TESTS_DIR = join(dirname(new URL(import.meta.url).pathname), "..");

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

export async function testGlobalsWebrun(t: any) {
    const cases = discoverGlobalsCases(join(TESTS_DIR, "globals"));
    if (cases.length === 0) throw new Error("No globals test cases discovered");

    for (const { dir, def } of cases) {
        await t.run(`[webrun] ${def.name}`, async () => {
            await runCliCase(dir, { ...def, expect: def.expect_webrun });
        });
    }
}

import * as self from "./globals_webrun.test.ts";
registerTests(self);
