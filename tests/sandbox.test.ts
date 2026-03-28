import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { discoverCases, runBatchCase, copyDirRecursive } from "./case_runner.ts";
import type { CaseDefinition, CaseExpect } from "./case_runner.ts";

// Fully permissive reference values.
const PERMISSIVE_LIMITS: Record<string, number> = {
    timeoutMillis: 300000,
    memoryMB: 4096,
};

// Check if a permission axis is at its maximally permissive value.
function isStoragePermissive(storage: any): boolean {
    if (!storage) return false;
    const dot = storage["."];
    if (!dot) return false;
    if (dot.access !== "read" && dot.access !== "write") return false;
    // If root is read-only, must have at least one write subdir to be
    // considered fully permissive. Read-only without write subdirs is
    // a storage.write restriction.
    if (dot.access === "read") {
        return Object.keys(storage).some(
            (k: string) => k !== "." && storage[k]?.access === "write"
        );
    }
    return true;
}

function isNetworkPermissive(network: any): boolean {
    if (!Array.isArray(network)) return false;
    if (network.length === 0) return false;
    return true; // has entries → permissive
}

function isEnvPermissive(env: any): boolean {
    if (!Array.isArray(env)) return false;
    if (env.length === 0) return false;
    return true; // has entries → permissive
}

function isLimitPermissive(key: string, value: any): boolean {
    if (value === undefined) return true; // absent = no limit = permissive
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

    const hint = `ERROR: Sandbox test "${caseName}" restricts multiple axes: [${restricted.join(", ")}].

Each sandbox test must target exactly ONE permission boundary.
The webrun.json should be maximally permissive except for the
one axis being tested, so auto-inversion can prove which
permission is the gating factor.

Fully permissive values:
  storage:  {".": {"access": "read"}, "<subdirs>": {"access": "write"}}
  network:  ["*"]
  env:      ["*"]
  limits:   ${JSON.stringify(PERMISSIVE_LIMITS)}`;
    throw new Error(hint);
}

// Build a permissive config by relaxing the one restricted axis.
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

export async function testSandboxCases(t: any) {
    const thisDir = dirname(new URL(import.meta.url).pathname);
    const cases = discoverCases(t, join(thisDir, "sandbox"));
    if (cases.length === 0) throw new Error("No sandbox test cases discovered");

    for (const { dir, def } of cases) {
        // Run the original case.
        await t.run(`[webrun] ${def.name}`, async () => {
            await runBatchCase(t, dir, def);
        });

        // Auto-inversion: for failing cases, relax the restricted axis and re-run.
        if (isFailingCase(def.expect)) {
            await t.run(`[INVERTED] ${def.name}`, async () => {
                // Read the webrun.json.
                let config: any;
                try {
                    const raw = t.testsys.readTextFileSync(join(dir, "webrun.json"));
                    config = JSON.parse(raw);
                } catch {
                    throw new Error(`[INVERTED] Cannot auto-invert "${def.name}": no webrun.json found in ${dir}`);
                }

                const axis = detectRestrictedAxis(config, def.name);
                if (axis === null) {
                    throw new Error(`[INVERTED] Cannot auto-invert "${def.name}": webrun.json is already fully permissive`);
                }

                // Copy case dir to temp, overwrite webrun.json with permissive config.
                const runDir = t.testsys.realPathSync(t.testsys.makeTempDirSync({ prefix: "inv_" }));
                copyDirRecursive(t, dir, runDir);

                const permissive = buildPermissiveConfig(config, axis);

                // For storage inversion, create the data subdirectory and copy
                // test files into it so the write-enabled scope is usable.
                if (axis === "storage") {
                    const dataDir = join(runDir, "data");
                    t.testsys.mkdirSync(dataDir, { recursive: true });
                    copyDirRecursive(t, dir, dataDir);
                }

                t.testsys.writeTextFileSync(
                    join(runDir, "webrun.json"),
                    JSON.stringify(permissive)
                );

                // Build an inverted definition expecting exit 0.
                const invertedDef: CaseDefinition = {
                    ...def,
                    expect: { exit_code: 0 },
                };

                await runBatchCase(t, runDir, invertedDef);
            });
        }
    }
}
