// policy_host.test.ts — Policy enforcement tests requiring the full host pipeline.
//
// Runner: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/policy_host.test.ts

import { registerTests } from "./_adapter.ts";
import { discoverCases, runCliCase } from "./_cli_runner.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

const TESTS_DIR = join(dirname(new URL(import.meta.url).pathname), "..");

export async function testPolicyHost(t: any) {
    const cases = discoverCases(join(TESTS_DIR, "policy"));
    if (cases.length === 0) throw new Error("No policy test cases discovered");

    for (const { dir, def } of cases) {
        await t.run(def.name, async () => {
            await runCliCase(dir, def);
        });
    }
}

import * as self from "./policy_host.test.ts";
registerTests(self);
