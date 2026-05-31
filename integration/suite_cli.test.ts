import { discoverCases } from "./suite.ts";
import { runCliCase } from "./runner_cli.ts";
import { runDenoShimCase } from "./runner_deno_shim.ts";

export async function testCliCases(t: any, ctx: any) {
    const suites = ["api", "cli", "globals", "opfs", "policy", "serve", "webrtc"];

    for (const suite of suites) {
        await t.run(`CLI Suite: ${suite}`, async (suiteT: any) => {
            const suiteDir = await ctx.integrationDir.getDirectoryHandle(suite);
            const cases = await discoverCases(suiteDir);
            const cliCases = cases.filter(c => c.def.runner === "cli" || c.def.runner === "deno-shim");

            if (cliCases.length === 0) return;

            for (const { dir, def } of cliCases) {
                await suiteT.run(def.name, async () => {
                    if (def.runner === "deno-shim") {
                        await runDenoShimCase(dir, def, ctx);
                    } else {
                        await runCliCase(dir, def, ctx);
                    }
                });
            }
        });
    }
}
