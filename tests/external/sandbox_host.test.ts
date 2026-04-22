// sandbox_host.test.ts — OS-level sandbox enforcement tests.
//
// Validates macOS seatbelt (sandbox-exec) and config auto-inversion.
// Each test case has a webrun.json that restricts exactly ONE permission axis.
// The test runner:
//   1. Runs the case expecting failure (restricted axis blocks the operation).
//   2. Auto-inverts: relaxes the restricted axis and reruns expecting success,
//      proving the boundary is the gating factor.
//
// Requires the full host pipeline (OS-level sandbox enforcement).
// Runner: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/sandbox_host.test.ts

import { registerTests, sys } from "./_adapter.ts";
import { discoverCases, runCliCase, copyDirRecursive, CaseDefinition, CaseExpect, WEBRUN_BIN } from "./_cli_runner.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

const TESTS_DIR = join(dirname(new URL(import.meta.url).pathname), "..");

// Fully permissive reference values.
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

export async function testSandboxHost(t: any) {
    const cases = discoverCases(join(TESTS_DIR, "sandbox"));
    if (cases.length === 0) throw new Error("No sandbox test cases discovered");

    for (const { dir, def } of cases) {
        // Run the original case (expecting failure due to restricted axis).
        await t.run(`[webrun] ${def.name}`, async () => {
            await runCliCase(dir, def);
        });

        // Auto-inversion: for failing cases, relax the restricted axis and re-run.
        if (isFailingCase(def.expect)) {
            await t.run(`[INVERTED] ${def.name}`, async () => {
                let config: any;
                try {
                    const raw = sys.readTextFileSync(join(dir, "webrun.json"));
                    config = JSON.parse(raw);
                } catch {
                    throw new Error(`[INVERTED] Cannot auto-invert "${def.name}": no webrun.json found in ${dir}`);
                }

                const axis = detectRestrictedAxis(config, def.name);
                if (axis === null) {
                    throw new Error(`[INVERTED] Cannot auto-invert "${def.name}": webrun.json is already fully permissive`);
                }

                // Copy case dir to temp, overwrite webrun.json with permissive config.
                const runDir = sys.realPathSync(sys.makeTempDirSync({ prefix: "inv_" }));
                copyDirRecursive(dir, runDir);

                const permissive = buildPermissiveConfig(config, axis);

                if (axis === "storage") {
                    const dataDir = join(runDir, "data");
                    sys.mkdirSync(dataDir, { recursive: true });
                    copyDirRecursive(dir, dataDir);
                }

                sys.writeTextFileSync(
                    join(runDir, "webrun.json"),
                    JSON.stringify(permissive)
                );

                const invDef = {
                    ...def,
                    expect: { exit_code: 0 as const },
                };

                await runCliCase(runDir, invDef);
            });
        }
    }
}

import * as self from "./sandbox_host.test.ts";
registerTests(self);
