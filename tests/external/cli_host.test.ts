// cli_host.test.ts — CLI test cases requiring the full host pipeline.
//
// Runs cases with "runner": "cli" from tests/cli/ directories. These need
// the host pipeline for import map resolution, type checking, etc.
//
// Runner: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/cli_host.test.ts

import { registerTests } from "./_adapter.ts";
import { discoverCases, runCliCase } from "./_cli_runner.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

const TESTS_DIR = join(dirname(new URL(import.meta.url).pathname), "..");

export async function testCliHost(t: any) {
    const cases = discoverCases(join(TESTS_DIR, "cli"));
    if (cases.length === 0) throw new Error("No CLI test cases discovered");

    // Only run cases that declare runner=cli.
    const cliCases = cases.filter(c => c.def.runner === "cli");
    if (cliCases.length === 0) throw new Error("No CLI host test cases found (runner: cli)");

    for (const { dir, def } of cliCases) {
        await t.run(def.name, async () => {
            await runCliCase(dir, def);
        });
    }
}

import * as self from "./cli_host.test.ts";
registerTests(self);
