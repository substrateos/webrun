import { discoverCases } from "./suite.ts";
import type { CaseExpect, DirHandle } from "./suite.ts";
import { copyDir } from "./runner.ts";
import { runCliCase } from "./runner_cli.ts";

const PERMISSIVE_LIMITS: Record<string, number> = {
    timeoutMillis: 300000,
    memoryMB: 4096,
};

function isStoragePermissive(storage: any): boolean {
    if (!storage) return false;
    const dot = storage["."];
    if (!dot) return false;
    if (dot.access !== "read" && dot.access !== "write") return false;
    if (dot.access === "read") {
        return Object.keys(storage).some(
            (k: string) => k !== "." && storage[k]?.access === "write"
        );
    }
    return true;
}

function isNetworkPermissive(network: any): boolean {
    return Array.isArray(network) && network.length > 0;
}

function isEnvPermissive(env: any): boolean {
    return Array.isArray(env) && env.length > 0;
}

function isLimitPermissive(key: string, value: any): boolean {
    if (value === undefined) return true;
    return value === PERMISSIVE_LIMITS[key];
}

function detectRestrictedAxis(config: any, caseName: string): string | null {
    const perms = config.permissions ?? {};
    const limits = config.limits ?? {};
    const restricted: string[] = [];

    if (!isStoragePermissive(perms.storage)) restricted.push("storage");
    if (!isNetworkPermissive(perms.network)) restricted.push("network");
    if (!isEnvPermissive(perms.env)) restricted.push("env");

    for (const axis of Object.keys(PERMISSIVE_LIMITS)) {
        if (!isLimitPermissive(axis, limits[axis])) {
            restricted.push(`limits.${axis}`);
        }
    }

    if (restricted.length === 0) return null;
    if (restricted.length === 1) return restricted[0];

    throw new Error(
        `ERROR: Sandbox test "${caseName}" restricts multiple axes: [${restricted.join(", ")}].\n` +
        `Each sandbox test must target exactly ONE permission boundary.`
    );
}

function buildPermissiveConfig(original: any, restrictedAxis: string): any {
    const config = JSON.parse(JSON.stringify(original));
    if (!config.permissions) config.permissions = {};

    if (restrictedAxis.startsWith("limits.")) {
        if (!config.limits) config.limits = {};
        const key = restrictedAxis.replace("limits.", "");
        config.limits[key] = PERMISSIVE_LIMITS[key];
    } else if (restrictedAxis === "storage") {
        config.permissions.storage = { ".": { access: "read" }, "data": { access: "write" } };
    } else if (restrictedAxis === "network") {
        config.permissions.network = ["*"];
    } else if (restrictedAxis === "env") {
        config.permissions.env = ["*"];
    }

    return config;
}

function isFailingCase(expect: CaseExpect): boolean {
    if (expect.exit_code === "nonzero") return true;
    if (typeof expect.exit_code === "number" && expect.exit_code !== 0) return true;
    return false;
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

        if (isFailingCase(def.expect!)) {
            await t.run(`[INVERTED] ${def.name}`, async () => {
                let config: any;
                try {
                    const raw = await readText(caseDir, "webrun.json");
                    config = JSON.parse(raw);
                } catch {
                    throw new Error(`[INVERTED] Cannot auto-invert "${def.name}": no webrun.json found`);
                }

                const axis = detectRestrictedAxis(config, def.name);
                if (axis === null) {
                    throw new Error(`[INVERTED] Cannot auto-invert "${def.name}": webrun.json is already fully permissive`);
                }

                const runDir = ctx.makeTempDir("inv_");
                await copyDir(caseDir, runDir);

                const permissive = buildPermissiveConfig(config, axis);

                if (axis === "storage") {
                    const dataDir = await runDir.getDirectoryHandle("data", { create: true });
                    await copyDir(caseDir, dataDir);
                }

                await writeText(runDir, "webrun.json", JSON.stringify(permissive));

                const invDef = { ...def, expect: { exit_code: 0 as const } };
                await runCliCase(runDir, invDef, ctx);
            });
        }
    }
}
