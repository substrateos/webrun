// location_config.test.ts — Table-driven unit tests for location config
// resolution and merge semantics.
//
// Two test suites:
//   1. resolveLocationConfig: path matching
//   2. applyLocationOverrides: merge semantics for limits, bindings, permissions
//
// Run via: ./webrun --self-test=LocationConfig

import { resolveLocationConfig, applyLocationOverrides } from "../src/host/mod.ts";
import type { WebrunConfig, WebrunLocationConfig } from "../src/types.ts";

// =========================================================
// CATEGORY 1: resolveLocationConfig — path matching
// =========================================================

interface MatchCase {
    name: string;
    config: WebrunConfig;
    configDir: string;
    targetPath: string;
    expected: WebrunLocationConfig | null;
}

const matchCases: MatchCase[] = [
    {
        name: "returns null when no locations defined",
        config: {},
        configDir: "/project",
        targetPath: "/project/main.ts",
        expected: null,
    },
    {
        name: "returns null when no location matches target",
        config: {
            locations: {
                // Keys are absolute after policy merge.
                "/project/src": { limits: { timeoutMillis: 1000 } },
            },
        },
        configDir: "/project",
        targetPath: "/project/lib/other.ts",
        expected: null,
    },
    {
        name: "matches exact file path",
        config: {
            locations: {
                "/project/main.ts": { limits: { timeoutMillis: 500 } },
            },
        },
        configDir: "/project",
        targetPath: "/project/main.ts",
        expected: { limits: { timeoutMillis: 500 } },
    },
    {
        name: "matches directory prefix",
        config: {
            locations: {
                "/project/src": { limits: { memoryMB: 128 } },
            },
        },
        configDir: "/project",
        targetPath: "/project/src/deep/module.ts",
        expected: { limits: { memoryMB: 128 } },
    },
    {
        name: "returns full location config with all fields",
        config: {
            locations: {
                "/project/worker": {
                    permissions: { network: ["api.example.com"] },
                    limits: { timeoutMillis: 5000, memoryMB: 256 },
                    bindings: { api: { command: "api-server" } },
                    importMap: "/project/worker/import_map.json",
                },
            },
        },
        configDir: "/project",
        targetPath: "/project/worker/handler.ts",
        expected: {
            permissions: { network: ["api.example.com"] },
            limits: { timeoutMillis: 5000, memoryMB: 256 },
            bindings: { api: { command: "api-server" } },
            importMap: "/project/worker/import_map.json",
        },
    },
    {
        name: "first matching location wins",
        config: {
            locations: {
                "/project/src": { limits: { timeoutMillis: 1000 } },
                "/project/src/deep": { limits: { timeoutMillis: 500 } },
            },
        },
        configDir: "/project",
        targetPath: "/project/src/deep/module.ts",
        expected: { limits: { timeoutMillis: 1000 } },
    },
];

// =========================================================
// CATEGORY 2: applyLocationOverrides — merge semantics
// =========================================================

interface MergeCase {
    name: string;
    rootConfig: WebrunConfig;
    location: WebrunLocationConfig;
    expectedLimits?: WebrunConfig["limits"];
    expectedBindings?: WebrunConfig["bindings"];
    expectedPermissions?: WebrunConfig["permissions"];
}

const mergeCases: MergeCase[] = [
    // ── Limits merge ──────────────────────────────────────────
    {
        name: "limits: location overrides specific root fields, root defaults preserved",
        rootConfig: {
            limits: { timeoutMillis: 30000, memoryMB: 512 },
        },
        location: {
            limits: { timeoutMillis: 500 },
        },
        expectedLimits: { timeoutMillis: 500, memoryMB: 512 },
    },
    {
        name: "limits: location adds fields when root has none",
        rootConfig: {},
        location: {
            limits: { timeoutMillis: 1000, memoryMB: 64 },
        },
        expectedLimits: { timeoutMillis: 1000, memoryMB: 64 },
    },
    {
        name: "limits: root preserved when location has no limits",
        rootConfig: {
            limits: { timeoutMillis: 5000 },
        },
        location: {
            permissions: { network: ["example.com"] },
        },
        expectedLimits: { timeoutMillis: 5000 },
    },
    {
        name: "limits: location overrides all root fields",
        rootConfig: {
            limits: { timeoutMillis: 30000, memoryMB: 512 },
        },
        location: {
            limits: { timeoutMillis: 500, memoryMB: 64 },
        },
        expectedLimits: { timeoutMillis: 500, memoryMB: 64 },
    },
    // ── Bindings merge ────────────────────────────────────────
    {
        name: "bindings: location adds new binding, root binding preserved",
        rootConfig: {
            bindings: { db: { command: "db-server" } },
        },
        location: {
            bindings: { cache: { command: "cache-server" } },
        },
        expectedBindings: {
            db: { command: "db-server" },
            cache: { command: "cache-server" },
        },
    },
    {
        name: "bindings: location overrides root binding with same name",
        rootConfig: {
            bindings: { db: { command: "db-v1" } },
        },
        location: {
            bindings: { db: { command: "db-v2" } },
        },
        expectedBindings: { db: { command: "db-v2" } },
    },
    {
        name: "bindings: location adds bindings when root has none",
        rootConfig: {},
        location: {
            bindings: { api: { command: "api-server" } },
        },
        expectedBindings: { api: { command: "api-server" } },
    },
    {
        name: "bindings: root preserved when location has no bindings",
        rootConfig: {
            bindings: { db: { command: "db-server" } },
        },
        location: {
            limits: { timeoutMillis: 1000 },
        },
        expectedBindings: { db: { command: "db-server" } },
    },
    // ── Permissions replace ───────────────────────────────────
    {
        name: "permissions: location replaces root (does not merge)",
        rootConfig: {
            permissions: { network: ["*"], env: ["HOME"] },
        },
        location: {
            permissions: { network: ["example.com"] },
        },
        expectedPermissions: { network: ["example.com"] },
    },
    {
        name: "permissions: root preserved when location has no permissions",
        rootConfig: {
            permissions: { network: ["*"] },
        },
        location: {
            limits: { timeoutMillis: 1000 },
        },
        expectedPermissions: { network: ["*"] },
    },
    // ── Combined ──────────────────────────────────────────────
    {
        name: "all fields: limits merged, bindings merged, permissions replaced",
        rootConfig: {
            limits: { timeoutMillis: 30000, memoryMB: 512 },
            bindings: { db: { command: "db-server" }, logger: { command: "log" } },
            permissions: { network: ["*"], env: ["HOME", "PATH"] },
        },
        location: {
            limits: { timeoutMillis: 500 },
            bindings: { cache: { command: "cache" }, db: { command: "db-v2" } },
            permissions: { network: ["api.example.com"] },
        },
        expectedLimits: { timeoutMillis: 500, memoryMB: 512 },
        expectedBindings: {
            db: { command: "db-v2" },
            logger: { command: "log" },
            cache: { command: "cache" },
        },
        expectedPermissions: { network: ["api.example.com"] },
    },
];

// =========================================================
// TEST RUNNERS
// =========================================================

function assertDeepEqual(actual: any, expected: any, label: string) {
    const a = JSON.stringify(actual, null, 2);
    const e = JSON.stringify(expected, null, 2);
    if (a !== e) {
        throw new Error(`${label} mismatch:\n  Expected: ${e}\n  Got:      ${a}`);
    }
}

export async function testLocationConfig(t: any) {
    // Category 1: path matching
    for (const tc of matchCases) {
        await t.run(tc.name, async () => {
            const result = resolveLocationConfig(tc.config, tc.configDir, tc.targetPath);
            assertDeepEqual(result, tc.expected, "resolveLocationConfig");
        });
    }

    // Category 2: merge semantics
    for (const tc of mergeCases) {
        await t.run(tc.name, async () => {
            // Clone to avoid cross-case mutation.
            const config: WebrunConfig = JSON.parse(JSON.stringify(tc.rootConfig));
            const location: WebrunLocationConfig = JSON.parse(JSON.stringify(tc.location));

            const { activePerms } = applyLocationOverrides(config, location);

            if (tc.expectedLimits !== undefined) {
                assertDeepEqual(config.limits, tc.expectedLimits, "config.limits");
            }
            if (tc.expectedBindings !== undefined) {
                assertDeepEqual(config.bindings, tc.expectedBindings, "config.bindings");
            }
            if (tc.expectedPermissions !== undefined) {
                assertDeepEqual(activePerms, tc.expectedPermissions, "activePerms (permissions)");
                assertDeepEqual(config.permissions, tc.expectedPermissions, "config.permissions");
            }
        });
    }
}
