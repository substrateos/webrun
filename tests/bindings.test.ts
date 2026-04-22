import { dir } from "webrun/ctx";
import { discoverCases, runBatchCase } from "./case_runner.ts";

export async function testBindings(t: any) {
    const bindingsDir = await dir.getDirectoryHandle("bindings");
    const cases = await discoverCases(bindingsDir);
    if (cases.length === 0) throw new Error("No bindings test cases discovered");

    for (const { dir: caseDir, def } of cases) {
        // Cases with runner=cli are in tests/external/bindings_host.test.ts.
        if (def.runner === "cli") continue;

        await t.run(def.name, async () => {
            await runBatchCase(caseDir, def);
        });
    }
}
