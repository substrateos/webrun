import { dir } from "webrun/ctx";
import { discoverCases, runBatchCase } from "./case_runner.ts";

export async function testCli(t: any) {
    const testsDir = await dir.getDirectoryHandle("tests");
    const cliDir = await testsDir.getDirectoryHandle("cli");
    const cases = await discoverCases(cliDir);
    if (cases.length === 0) throw new Error("No CLI test cases discovered");

    for (const { dir: caseDir, def } of cases) {
        // Cases with runner=cli are in tests/external/cli_host.test.ts.
        if (def.runner === "cli") continue;

        await t.run(def.name, async () => {
            await runBatchCase(caseDir, def);
        });
    }
}
