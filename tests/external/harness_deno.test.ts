// harness_deno.test.ts — Dual-pass validation for src/test_harness.ts.
//
// Runs the IDENTICAL category functions from harness.test.ts via Deno.test.
// A shim adapts Deno.TestContext → TestContext so the same bodies execute
// through Deno's native runner. Step counts must match the webrun pass.
//
// Run: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/harness_deno.test.ts

import { denoTest } from "./_adapter.ts";
import {
    testCategory1_CoreAssertions,
    testCategory2_SkipSemantics,
    testCategory3_Nesting,
    testCategory4_Filtering,
    testCategory5_ErrorIsolation,
    testCategory6_OutputFormat,
    testCategory7_EdgeCases,
} from "../harness.test.ts";

for (const fn of [
    testCategory1_CoreAssertions,
    testCategory2_SkipSemantics,
    testCategory3_Nesting,
    testCategory4_Filtering,
    testCategory5_ErrorIsolation,
    testCategory6_OutputFormat,
    testCategory7_EdgeCases,
]) {
    denoTest(fn.name.replace(/^test/, ""), fn);
}
