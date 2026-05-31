import { discoverCases } from "./suite.ts";
import runWorkerCase from "./runner_worker.ts";
import type { Context } from "../src/core/types.ts";

export async function testWorkerCases(t: any, ctx: Context) {
    const testsDir = await ctx.dir.getDirectoryHandle("integration");
    const suites = ["api", "cli", "policy"];

    for (const suite of suites) {
        await t.run(`Worker Suite: ${suite}`, async (suiteT: any) => {
            const suiteDir = await testsDir.getDirectoryHandle(suite);
            const cases = await discoverCases(suiteDir);
            if (cases.length === 0) throw new Error(`No test cases discovered for suite: ${suite}`);

            for (const { dir: caseDir, def } of cases) {
                // Cases with runner=cli are executed via the CLI pipeline.
                if (def.runner === "cli") continue;

                await suiteT.run(def.name, async () => {
                    await runWorkerCase(caseDir, def, ctx);
                });
            }
        });
    }
}
