// harness_deno.test.ts — Dual-pass validation for src/test_harness.ts.
//
// Runs the IDENTICAL category functions from harness.test.ts via Deno.test.
// A shim adapts Deno.TestContext → TestContext so the same bodies execute
// through Deno's native runner. Step counts must match the webrun pass.
//
// Run: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/harness_deno.test.ts

import { registerTests } from "./deno.ts";
import * as harness from "./webrun.test.ts";

registerTests("harness", harness);
