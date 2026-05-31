import validate, { validateCapabilityChain } from "./policy.ts";
import { SecurityViolation } from "../types.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeConfig = (perms: Record<string, any>, dir: string, limits?: Record<string, any>) => ({
    dir: { name: dir } as unknown as FileSystemDirectoryHandle,
    file: null as any,
    config: { permissions: perms, limits: limits ?? {}, isolate: perms.isolate },
    locationConfig: { permissions: perms, limits: limits ?? {} },
    protectedFiles: [] as FileSystemFileHandle[],
    importMap: undefined,
});

const resolveDir = (h: any) => "/" + h.name;
const canonicalize = (p: string) => p;

// ── Chain Validation: Wildcard Semantics ─────────────────────────────────────

type ChainCase = {
    name: string;
    child: Record<string, any>;
    parent: Record<string, any>;
    expectViolations: number;
    expectCode?: SecurityViolation;
};

const wildcardCases: ChainCase[] = [
    // ── Network ──
    {
        name: "network: parent * permits child specific",
        child: { network: ["example.com"] },
        parent: { network: ["*"] },
        expectViolations: 0,
    },
    {
        name: "network: parent * permits child *",
        child: { network: ["*"] },
        parent: { network: ["*"] },
        expectViolations: 0,
    },
    {
        name: "network: parent specific blocks child *",
        child: { network: ["*"] },
        parent: { network: ["example.com"] },
        expectViolations: 1,
        expectCode: SecurityViolation.CapabilityEscalation,
    },
    {
        name: "network: parent absent blocks child specific",
        child: { network: ["example.com"] },
        parent: {},
        expectViolations: 1,
        expectCode: SecurityViolation.CapabilityEscalation,
    },

    // ── Env ──
    {
        name: "env: parent * permits child specific",
        child: { env: ["SECRET"] },
        parent: { env: ["*"] },
        expectViolations: 0,
    },
    {
        name: "env: parent * permits child *",
        child: { env: ["*"] },
        parent: { env: ["*"] },
        expectViolations: 0,
    },
    {
        name: "env: parent specific blocks child *",
        child: { env: ["*"] },
        parent: { env: ["HOME"] },
        expectViolations: 1,
        expectCode: SecurityViolation.CapabilityEscalation,
    },
    {
        name: "env: parent absent blocks child specific",
        child: { env: ["SECRET"] },
        parent: {},
        expectViolations: 1,
        expectCode: SecurityViolation.CapabilityEscalation,
    },

    // ── Import ──
    {
        name: "import: parent * permits child specific",
        child: { import: ["example.com"] },
        parent: { import: ["*"] },
        expectViolations: 0,
    },
    {
        name: "import: parent * permits child *",
        child: { import: ["*"] },
        parent: { import: ["*"] },
        expectViolations: 0,
    },
    {
        name: "import: parent specific blocks child *",
        child: { import: ["*"] },
        parent: { import: ["cdn.example.com"] },
        expectViolations: 1,
        expectCode: SecurityViolation.CapabilityEscalation,
    },
    {
        name: "import: parent absent blocks child specific",
        child: { import: ["example.com"] },
        parent: {},
        expectViolations: 1,
        expectCode: SecurityViolation.CapabilityEscalation,
    },

    // ── GPU ──
    {
        name: "gpu: parent true permits child true",
        child: { gpu: true },
        parent: { gpu: true },
        expectViolations: 0,
    },
    {
        name: "gpu: parent absent blocks child true",
        child: { gpu: true },
        parent: {},
        expectViolations: 1,
        expectCode: SecurityViolation.CapabilityEscalation,
    },

    // ── WebRTC ──
    {
        name: "webrtc: parent true permits child true",
        child: { webrtc: true },
        parent: { webrtc: true },
        expectViolations: 0,
    },
    {
        name: "webrtc: parent absent blocks child true",
        child: { webrtc: true },
        parent: {},
        expectViolations: 1,
        expectCode: SecurityViolation.CapabilityEscalation,
    },

    // ── Storage ──
    {
        name: "storage: parent write permits child read (same path)",
        child: { storage: { "data": { access: "read" } } },
        parent: { storage: { "data": { access: "write" } } },
        expectViolations: 0,
    },
    {
        name: "storage: parent read blocks child write",
        child: { storage: { "data": { access: "write" } } },
        parent: { storage: { "data": { access: "read" } } },
        expectViolations: 1,
        expectCode: SecurityViolation.CapabilityEscalation,
    },
    {
        name: "storage: parent absent blocks child read",
        child: { storage: { "data": { access: "read" } } },
        parent: {},
        expectViolations: 1,
        expectCode: SecurityViolation.CapabilityEscalation,
    },

    // ── Network Isolation ──
    {
        name: "isolate: storage inside isolate denies network",
        child: { storage: { "isolated": { access: "write" } }, network: ["example.com"] },
        parent: { isolate: ["isolated"], network: ["*"], storage: { "isolated": { access: "write" } } },
        expectViolations: 1,
        expectCode: SecurityViolation.NetworkIsolation,
    },
    {
        name: "isolate: storage inside isolate permits no network",
        child: { storage: { "isolated": { access: "read" } } },
        parent: { isolate: ["isolated"], storage: { "isolated": { access: "read" } } },
        expectViolations: 0,
    },
    {
        name: "isolate: storage outside isolate permits network",
        child: { storage: { "data": { access: "read" } }, network: ["example.com"] },
        parent: { isolate: ["isolated"], network: ["*"], storage: { "data": { access: "read" } } },
        expectViolations: 0,
    },

    // ── Combined: narrowing is valid ──
    {
        name: "combined: child narrows all parent wildcards",
        child: { network: ["a.com"], env: ["X"], import: ["cdn.com"] },
        parent: { network: ["*"], env: ["*"], import: ["*"] },
        expectViolations: 0,
    },
];

export async function testChainWildcardSemantics(t: any) {
    for (const tc of wildcardCases) {
        await t.run(tc.name, (inner: any) => {
            const chain = [makeConfig(tc.child, "testdir"), makeConfig(tc.parent, "testdir")];
            const violations = validateCapabilityChain(chain, resolveDir, canonicalize);
            inner.assert(
                violations.length === tc.expectViolations,
                `Expected ${tc.expectViolations} violations, got ${violations.length}: ${violations.map(v => v.message).join("; ")}`,
            );
            if (tc.expectCode && violations.length > 0) {
                inner.assert(
                    violations[0].code === tc.expectCode,
                    `Expected code ${tc.expectCode}, got ${violations[0].code}`,
                );
            }
        });
    }
}

// ── Binary Prefix Validation ─────────────────────────────────────────────────

type BinaryPrefixCase = {
    name: string;
    argv: string[];
    allowedPrefixes: string[][];
    expectViolations: number;
};

const binaryPrefixCases: BinaryPrefixCase[] = [
    {
        name: "exact match: absolute prefix matches absolute argv",
        argv: ["/usr/bin/git", "rev-list"],
        allowedPrefixes: [["/usr/bin/git", "rev-list"]],
        expectViolations: 0,
    },
    {
        name: "no match: different binary rejected",
        argv: ["/usr/bin/curl", "http://evil.com"],
        allowedPrefixes: [["/usr/bin/git"]],
        expectViolations: 1,
    },
    {
        name: "resolved prefix matches resolved argv",
        argv: ["/project/echo-port"],
        allowedPrefixes: [["/project/echo-port"]],
        expectViolations: 0,
    },
    {
        name: "bare name matches bare argv (PATH lookup)",
        argv: ["llama-server", "--port", "8080"],
        allowedPrefixes: [["llama-server"]],
        expectViolations: 0,
    },
    {
        name: "no prefixes rejects any binary",
        argv: ["/usr/bin/git"],
        allowedPrefixes: [],
        expectViolations: 1,
    },
];

export async function testBinaryPrefixValidation(t: any) {
    for (const tc of binaryPrefixCases) {
        await t.run(tc.name, (inner: any) => {
            const violations = validate({
                mode: "binary",
                argv: tc.argv,
                allowedBinaryPrefixes: tc.allowedPrefixes,
                protectedPaths: [],
                allowedWritePaths: [],
                resolveDir: (h: any) => "/" + h.name,
                canonicalize: (p: string) => p,
            });
            inner.assert(
                violations.length === tc.expectViolations,
                `Expected ${tc.expectViolations} violations, got ${violations.length}: ${violations.map((v: any) => v.message).join("; ")}`,
            );
        });
    }
}
