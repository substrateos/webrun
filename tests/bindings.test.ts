import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { discoverCases, runBatchCase } from "./case_runner.ts";

export async function testBindings(t: any) {
    const thisDir = dirname(new URL(import.meta.url).pathname);
    const cases = discoverCases(t, join(thisDir, "bindings"));
    if (cases.length === 0) throw new Error("No bindings test cases discovered");

    for (const { dir, def } of cases) {
        await t.run(def.name, async () => {
            await runBatchCase(t, dir, def);
        });
    }
}
