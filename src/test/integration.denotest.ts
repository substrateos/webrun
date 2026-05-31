// Integration test entrypoint — registers suites that live outside src/.
// Unit tests under src/ are auto-discovered via native.generated.denotest.ts.

import * as integration_cli from "../../integration/suite_cli.test.ts";
import * as integration_sandbox from "../../integration/suite_sandbox.test.ts";

import { registerTests } from "../deno/test/deno.ts";

registerTests("integration_cli", integration_cli)
registerTests("integration_sandbox", integration_sandbox)
