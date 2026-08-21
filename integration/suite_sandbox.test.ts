import { discoverCases } from "./suite.ts";
import type { CaseExpect, DirHandle } from "./suite.ts";
import { copyDir } from "./runner.ts";
import { runCliCase } from "./runner_cli.ts";

function negateContainsRules(rules?: import("./suite.ts").ContainsRule[]): import("./suite.ts").ContainsRule[] | undefined {
    if (!rules) return undefined;
    return rules.map(rule => {
        if (rule.contains !== undefined) return { absent: rule.contains };
        if (rule.absent !== undefined) return { contains: rule.absent };
        return rule;
    });
}

function negateExpectations(expect: CaseExpect): CaseExpect {
    const negated: CaseExpect = {
        exit_code: (expect.exit_code === 0) ? "nonzero" : 0,
    };
    if (expect.stdout) negated.stdout = negateContainsRules(expect.stdout);
    if (expect.stderr) negated.stderr = negateContainsRules(expect.stderr);
    if (expect.ready) {
        negated.ready = {};
        if (expect.ready.stdout) negated.ready.stdout = negateContainsRules(expect.ready.stdout);
        if (expect.ready.stderr) negated.ready.stderr = negateContainsRules(expect.ready.stderr);
    }
    if (expect.files) {
        negated.files = expect.files.map(f => {
            const inverted = { ...f };
            if (typeof f.exists === "boolean") inverted.exists = !f.exists;
            return inverted;
        });
    }
    return negated;
}

/** Read text from a file handle inside a directory. */
async function readText(dir: DirHandle, name: string): Promise<string> {
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    return file.text();
}

/** Write text to a file handle inside a directory. */
async function writeText(dir: DirHandle, name: string, content: string): Promise<void> {
    const fh = await dir.getFileHandle(name, { create: true });
    const writable = await fh.createWritable();
    await writable.write(content);
    await writable.close();
}

export async function testSandboxHost(t: any, ctx: any) {
    const sandboxDir = await ctx.integrationDir.getDirectoryHandle("sandbox");
    const cases = await discoverCases(sandboxDir);
    if (cases.length === 0) throw new Error("No sandbox test cases discovered");

    for (const { dir: caseDir, def } of cases) {
        await t.run(`[webrun] ${def.name}`, async () => {
            await runCliCase(caseDir, def, ctx);
        });

        if (def.expect?.negation) {
            await t.run(`[NEGATED] ${def.name}`, async () => {
                let config: any = {};
                try {
                    const raw = await readText(caseDir, "webrun.json");
                    config = JSON.parse(raw);
                } catch {
                    // It's ok if there's no webrun.json, we will create one
                }

                const runDir = ctx.makeTempDir("neg_");
                await copyDir(caseDir, runDir);

                // Shallow merge: negation.permissions intentionally replaces entire
                // permission axes (e.g. storage, network) rather than deep-merging.
                // Each negation block must declare the complete replacement value.
                if (def.expect.negation!.permissions) {
                    config.permissions = { ...config.permissions, ...def.expect.negation!.permissions };
                }
                if (def.expect.negation!.limits) {
                    config.limits = { ...config.limits, ...def.expect.negation!.limits };
                }

                if (config.permissions?.storage?.data) {
                    const dataDir = await runDir.getDirectoryHandle("data", { create: true });
                    await copyDir(caseDir, dataDir);
                }

                await writeText(runDir, "webrun.json", JSON.stringify(config, null, 2));

                const negDef = { ...def, expect: negateExpectations(def.expect!) };
                await runCliCase(runDir, negDef, ctx);
            });
        }
    }
}
