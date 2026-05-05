import { dir } from "webrun/ctx";
import { discoverCases, runBatchCase } from "./case_runner.ts";

export async function testPolicy(t: any) {
    const policyDir = await dir.getDirectoryHandle("policy");
    const cases = await discoverCases(policyDir);
    if (cases.length === 0) throw new Error("No Policy test cases discovered");

    for (const { dir: caseDir, def } of cases) {
        if (def.runner === "cli") continue;

        await t.run(def.name, async () => {
            await runBatchCase(caseDir, def);
        });
    }
}
