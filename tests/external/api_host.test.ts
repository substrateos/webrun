// api_host.test.ts — API test cases requiring the full host pipeline.
//
// Runs cases with "runner": "cli" from tests/api/ directories. These need
// the host pipeline for import map resolution, WebRTC polyfill injection, etc.
//
// Runner: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/api_host.test.ts

import { registerTests } from "./_adapter.ts";
import { discoverCases, runCliCase } from "./_cli_runner.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

const TESTS_DIR = join(dirname(new URL(import.meta.url).pathname), "..");

export async function testApiHost(t: any) {
    const cases = discoverCases(join(TESTS_DIR, "api"));
    if (cases.length === 0) throw new Error("No API test cases discovered");

    // Only run cases that declare runner=cli.
    const cliCases = cases.filter(c => c.def.runner === "cli");
    if (cliCases.length === 0) throw new Error("No API host test cases found (runner: cli)");

    for (const { dir, def } of cliCases) {
        await t.run(def.name, async () => {
            await runCliCase(dir, def);
        });
    }
}

import * as self from "./api_host.test.ts";
registerTests(self);
