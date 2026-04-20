import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { discoverCases, runSignalCase } from "./case_runner.ts";

export async function testServe(t: any) {
    const thisDir = dirname(new URL(import.meta.url).pathname);
    const cases = discoverCases(t, join(thisDir, "serve"));

    for (const { dir, def } of cases) {
        await t.run(def.name, async () => {
            await runSignalCase(t, dir, def);
        });
    }
}
