import { resolveLocationChain, mergeConfigurations } from "./config.ts";
import type { LocalConfig } from "./config.ts";
import type { WebrunLocationConfig, WebrunConfig } from "./types.ts";

function makeLocalConfig(resolvedConfig: WebrunLocationConfig, dirName: string): LocalConfig {
    return {
        config: resolvedConfig as WebrunConfig,
        locationConfig: resolvedConfig,
        dir: { kind: "directory", name: dirName } as unknown as FileSystemDirectoryHandle,
        file: { kind: "file", name: "webrun.json" } as unknown as FileSystemFileHandle,
        protectedFiles: [],
    };
}

// Stub resolveDir that treats dir.name as the absolute path
const resolveDir = (h: FileSystemDirectoryHandle): string => h.name;

interface ChainCase {
    name: string;
    configs: LocalConfig[];
    targetPath: string;
    expectedCount: number;
    expectedLimits?: (WebrunLocationConfig["limits"])[];
}

const chainCases: ChainCase[] = [
    {
        name: "returns configs even when no locations exist",
        configs: [makeLocalConfig({}, "/project")],
        targetPath: "/project/main.ts",
        expectedCount: 1,
    },
    {
        name: "includes matching location entry after its parent config",
        configs: [
            makeLocalConfig(
                {
                    limits: { timeoutMillis: 1000 },
                    locations: { "/project/src/": { limits: { timeoutMillis: 500 } } },
                } as WebrunConfig,
                "/project",
            ),
        ],
        targetPath: "/project/src/main.ts",
        expectedCount: 2,
        expectedLimits: [{ timeoutMillis: 1000 }, { timeoutMillis: 500 }],
    },
    {
        name: "matches across multiple configs (child first, parent last)",
        configs: [
            makeLocalConfig(
                { locations: { "/project/src/": { limits: { timeoutMillis: 500 } } } } as WebrunConfig,
                "/project",
            ),
            makeLocalConfig(
                { locations: { "/project/src/": { limits: { timeoutMillis: 1000 } } } } as WebrunConfig,
                "/",
            ),
        ],
        targetPath: "/project/src/main.ts",
        expectedCount: 4,
        expectedLimits: [undefined, { timeoutMillis: 500 }, undefined, { timeoutMillis: 1000 }],
    },
    {
        name: "skips configs without matching locations",
        configs: [
            makeLocalConfig(
                { locations: { "/project/src/": { limits: { timeoutMillis: 500 } } } } as WebrunConfig,
                "/project",
            ),
            makeLocalConfig(
                { locations: { "/other/": { limits: { timeoutMillis: 1000 } } } } as WebrunConfig,
                "/",
            ),
        ],
        targetPath: "/project/src/main.ts",
        expectedCount: 3,
    },
];

export async function testResolveLocalChain(t: any) {
    // Category 1: chain-aware path matching
    for (const tc of chainCases) {
        await t.run(tc.name, async () => {
            const result = await resolveLocationChain(tc.targetPath, tc.configs, resolveDir);
            if (result.length !== tc.expectedCount) {
                throw new Error(`Expected ${tc.expectedCount} matches, got ${result.length}`);
            }
            if (tc.expectedLimits) {
                for (let i = 0; i < tc.expectedLimits.length; i++) {
                    assertDeepEqual(result[i].locationConfig.limits, tc.expectedLimits[i], `match[${i}].limits`);
                }
            }
        });
    }
}
interface MergeCase {
    name: string;
    configs: LocalConfig[];
    expectedPermissions?: WebrunLocationConfig["permissions"];
    expectedLimits?: WebrunLocationConfig["limits"];
}

const mergeCases: MergeCase[] = [
    {
        name: "single config passes through",
        configs: [
            makeLocalConfig({ permissions: { network: ["example.com"] }, limits: { timeoutMillis: 1000 } }, "/project"),
        ],
        expectedPermissions: { network: ["example.com"] },
        expectedLimits: { timeoutMillis: 1000 },
    },
    {
        name: "child permissions override parent (child-wins)",
        configs: [
            makeLocalConfig({ permissions: { network: ["child.com"] } }, "/project"),
            makeLocalConfig({ permissions: { network: ["parent.com"], env: ["HOME"] } }, "/"),
        ],
        expectedPermissions: { network: ["child.com"], env: ["HOME"] },
    },
    {
        name: "child limits override parent (child-wins)",
        configs: [
            makeLocalConfig({ limits: { timeoutMillis: 500 } }, "/project"),
            makeLocalConfig({ limits: { timeoutMillis: 1000, memoryMB: 256 } }, "/"),
        ],
        expectedLimits: { timeoutMillis: 500, memoryMB: 256 },
    },
    {
        name: "parent-only fields preserved when child has none",
        configs: [
            makeLocalConfig({}, "/project"),
            makeLocalConfig({ permissions: { network: ["parent.com"] }, limits: { memoryMB: 512 } }, "/"),
        ],
        expectedPermissions: { network: ["parent.com"] },
        expectedLimits: { memoryMB: 512 },
    },
];

export async function testMergeConfigurations(t: any) {
    for (const tc of mergeCases) {
        await t.run(tc.name, async () => {
            const merged = mergeConfigurations(tc.configs, resolveDir);
            if (tc.expectedPermissions !== undefined) {
                assertDeepEqual(merged.config.permissions, tc.expectedPermissions, "permissions");
            }
            if (tc.expectedLimits !== undefined) {
                assertDeepEqual(merged.config.limits, tc.expectedLimits, "limits");
            }
        });
    }
}

// ── Storage path resolution during merge ─────────────────────────────────────
// Storage paths in each config are relative to that config's own directory.
// mergeConfigurations must resolve them against their own dir, not the merged dir.

interface StorageResolutionCase {
    name: string;
    configs: LocalConfig[];
    expectedStorageKeys: string[];
}

const storageResolutionCases: StorageResolutionCase[] = [
    {
        name: "parent storage does not cascade to child without storage",
        configs: [
            makeLocalConfig({}, "/project/child"),
            makeLocalConfig({ permissions: { storage: { "data": { access: "write" } } } }, "/project"),
        ],
        expectedStorageKeys: [],
    },
    {
        name: "child storage resolved against child dir",
        configs: [
            makeLocalConfig({ permissions: { storage: { ".": { access: "read" } } } }, "/project/child"),
            makeLocalConfig({}, "/project"),
        ],
        expectedStorageKeys: ["/project/child"],
    },
    {
        name: "child storage replaces parent (child-wins, per-config resolution)",
        configs: [
            makeLocalConfig({ permissions: { storage: { ".": { access: "read" } } } }, "/project/child"),
            makeLocalConfig({ permissions: { storage: { "case": { access: "write" } } } }, "/runDir"),
        ],
        // Child-wins: only child's storage survives, resolved against child's dir.
        expectedStorageKeys: ["/project/child"],
    },
    {
        name: "parent storage does NOT cascade to child without storage",
        configs: [
            makeLocalConfig({ permissions: { network: ["example.com"] } }, "/project/child"),
            makeLocalConfig({ permissions: { storage: { "case": { access: "read" } } } }, "/runDir"),
        ],
        // Parent's storage is its own capability — child didn't claim any storage.
        // Non-storage permissions (network) still cascade normally.
        expectedStorageKeys: [],
    },
];

export async function testStorageResolution(t: any) {
    for (const tc of storageResolutionCases) {
        await t.run(tc.name, async () => {
            const merged = mergeConfigurations(tc.configs, resolveDir);
            const storageKeys = Object.keys(merged.config.permissions?.storage || {}).sort();
            const expectedKeys = [...tc.expectedStorageKeys].sort();
            assertDeepEqual(storageKeys, expectedKeys, "storage keys");
        });
    }
}

function assertDeepEqual(actual: any, expected: any, label: string) {
    const a = JSON.stringify(actual, null, 2);
    const e = JSON.stringify(expected, null, 2);
    if (a !== e) {
        throw new Error(`${label} mismatch:\n  Expected: ${e}\n  Got:      ${a}`);
    }
}

// ── P1: `permissions` field activation ───────────────────────────────────────
// The `permissions` field in webrun.json activates the permission regime.
// The adapter checks `"permissions" in chain[0].locationConfig` to determine
// whether permissive defaults or restricted mode applies.

interface PermissionsActivatedCase {
    name: string;
    configs: LocalConfig[];
    expected: boolean;
}

const permissionsActivatedCases: PermissionsActivatedCase[] = [
    {
        name: "child with permissions field → activated",
        configs: [
            makeLocalConfig({ permissions: { storage: { ".": { access: "read" } } } }, "/project/child"),
            makeLocalConfig({ permissions: { storage: { "case": { access: "read" } } } }, "/runDir"),
        ],
        expected: true,
    },
    {
        name: "child with empty permissions → activated",
        configs: [
            makeLocalConfig({ permissions: {} }, "/project/child"),
            makeLocalConfig({ permissions: { storage: { "case": { access: "read" } } } }, "/runDir"),
        ],
        expected: true,
    },
    {
        name: "child without permissions field → not activated",
        configs: [
            makeLocalConfig({ limits: { timeoutMillis: 1000 } }, "/project/child"),
            makeLocalConfig({ permissions: { storage: { "case": { access: "read" } } } }, "/runDir"),
        ],
        expected: false,
    },
    {
        name: "child with no config fields → not activated",
        configs: [
            makeLocalConfig({}, "/project/child"),
            makeLocalConfig({ permissions: { storage: { "case": { access: "read" } } } }, "/runDir"),
        ],
        expected: false,
    },
    {
        name: "parent has permissions but child does not → not activated",
        configs: [
            makeLocalConfig({ limits: { memoryMB: 128 } }, "/project/child"),
            makeLocalConfig({ permissions: { network: ["example.com"], storage: { "case": { access: "read" } } } }, "/runDir"),
        ],
        expected: false,
    },
];

export async function testPermissionsActivated(t: any) {
    for (const tc of permissionsActivatedCases) {
        await t.run(tc.name, async () => {
            const activated = "permissions" in tc.configs[0].locationConfig;
            if (activated !== tc.expected) {
                throw new Error(`permissionsActivated: expected ${tc.expected}, got ${activated}`);
            }
        });
    }
}

// ── Location `dir` field ─────────────────────────────────────────────────────
// Location entries can declare a `dir` field that provides the working directory
// for targets matching that location. The dir is resolved relative to the
// declaring config's directory. Child-wins semantics apply.

interface LocationDirCase {
    name: string;
    configs: LocalConfig[];
    targetPath: string;
    expectedDir: string | undefined;
}

const locationDirCases: LocationDirCase[] = [
    {
        name: "location with dir → merged config carries resolved dir",
        configs: [
            makeLocalConfig(
                { locations: { "/project/server.ts": { dir: "./data" } } } as WebrunConfig,
                "/project",
            ),
        ],
        targetPath: "/project/server.ts",
        expectedDir: "/project/data",
    },
    {
        name: "location without dir → no dir in merged config",
        configs: [
            makeLocalConfig(
                { locations: { "/project/server.ts": { permissions: { network: ["example.com"] } } } } as WebrunConfig,
                "/project",
            ),
        ],
        targetPath: "/project/server.ts",
        expectedDir: undefined,
    },
    {
        name: "dir resolved relative to config's own directory",
        configs: [
            makeLocalConfig({}, "/project/child"),
            makeLocalConfig(
                { locations: { "/project/child/server.ts": { dir: "./srv-data" } } } as WebrunConfig,
                "/project",
            ),
        ],
        targetPath: "/project/child/server.ts",
        expectedDir: "/project/srv-data",
    },
    {
        name: "child dir overrides parent dir (child-wins)",
        configs: [
            makeLocalConfig(
                { locations: { "/project/server.ts": { dir: "./child-data" } } } as WebrunConfig,
                "/project",
            ),
            makeLocalConfig(
                { locations: { "/project/server.ts": { dir: "./parent-data" } } } as WebrunConfig,
                "/",
            ),
        ],
        targetPath: "/project/server.ts",
        expectedDir: "/project/child-data",
    },
];

export async function testLocationDir(t: any) {
    for (const tc of locationDirCases) {
        await t.run(tc.name, async () => {
            const chain = await resolveLocationChain(tc.targetPath, tc.configs, resolveDir);
            const merged = mergeConfigurations(chain, resolveDir);
            const actualDir = merged.config.dir;
            if (actualDir !== tc.expectedDir) {
                throw new Error(`dir: expected ${JSON.stringify(tc.expectedDir)}, got ${JSON.stringify(actualDir)}`);
            }
        });
    }
}
