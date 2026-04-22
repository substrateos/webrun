// serve_host.test.ts — Serve mode tests requiring real OS port binding and signal lifecycle.
//
// Runner: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/serve_host.test.ts

import { registerTests } from "./_adapter.ts";
import { discoverCases, runCliSignalCase } from "./_cli_runner.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

const TESTS_DIR = join(dirname(new URL(import.meta.url).pathname), "..");

export async function testServeHost(t: any) {
    const cases = discoverCases(join(TESTS_DIR, "serve"));
    if (cases.length === 0) throw new Error("No serve test cases discovered");

    for (const { dir, def } of cases) {
        await t.run(def.name, async () => {
            await runCliSignalCase(dir, def);
        });
    }
}

import * as self from "./serve_host.test.ts";
registerTests(self);
