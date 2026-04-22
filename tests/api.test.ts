import { dir } from "webrun/ctx";
import { discoverCases, runBatchCase, runSignalCase } from "./case_runner.ts";

export async function testApi(t: any) {
    const apiDir = await dir.getDirectoryHandle("api");
    const cases = await discoverCases(apiDir);
    if (cases.length === 0) throw new Error("No API test cases discovered");

    for (const { dir: caseDir, def } of cases) {
        // Cases with runner=cli are in tests/external/api_host.test.ts.
        if (def.runner === "cli") continue;

        await t.run(def.name, async () => {
            if (def.signal) {
                await runSignalCase(caseDir, def);
            } else {
                await runBatchCase(caseDir, def);
            }
        });
    }
}
