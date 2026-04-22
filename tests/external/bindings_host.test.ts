// bindings_host.test.ts — Binding tests requiring the full host pipeline.
//
// These tests need real OS process spawning for binding backends, fetch
// interception (--deny-net), and ctx.stdout WritableStream wiring — all
// features provided by host.ts that are unavailable in ctx.webrun() Workers.
//
// Runner: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/bindings_host.test.ts

import { registerTests } from "./_adapter.ts";
import { discoverCases, runCliCase } from "./_cli_runner.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

const TESTS_DIR = join(dirname(new URL(import.meta.url).pathname), "..");

export async function testBindingsHost(t: any) {
    const cases = discoverCases(join(TESTS_DIR, "bindings"));
    if (cases.length === 0) throw new Error("No binding test cases discovered");

    // Only run cases that declare runner=cli.
    const cliCases = cases.filter(c => c.def.runner === "cli");
    if (cliCases.length === 0) throw new Error("No binding host test cases found (runner: cli)");

    for (const { dir, def } of cliCases) {
        await t.run(def.name, async () => {
            await runCliCase(dir, def);
        });
    }
}

import * as self from "./bindings_host.test.ts";
registerTests(self);
