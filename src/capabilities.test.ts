import { resolveCapabilities, augmentForJail, SYSTEM_READ_PATHS } from "./core/capabilities.ts";
import type { ResolvedCapabilities } from "./core/capabilities.ts";
import type { BundleInfo } from "./core/bundle.ts";
import type { WebrunPermissions } from "./core/types.ts";

// ── Fixtures ──

const BUNDLE: BundleInfo = {
    version: "0.0.0-test",
    execPath: "/usr/bin/deno",
    binDir: "/usr/bin",
    main: "/opt/webrun/webrun.js",
    sourceDirs: ["/opt/webrun"],
    protectedPaths: ["/opt/webrun"],
};

const identity = (p: string) => p;

// ── resolveCapabilities: table-driven ──

const capsCases: {
    name: string;
    permissions: WebrunPermissions;
    os?: "darwin" | "linux";
    ports?: number[];
    dir?: string;
    tempDir?: string;
    canonicalize?: (p: string) => string;
    assert: (caps: ResolvedCapabilities) => void;
}[] = [
    {
        name: "storage read path resolved against dir",
        permissions: { storage: { "src": { access: "read" } } },
        assert: (c) => {
            if (!c.readPaths.find(p => p.path === "/project/src")) throw new Error(`Missing /project/src in readPaths`);
        },
    },
    {
        name: "storage write path implies read",
        permissions: { storage: { "data": { access: "write" } } },
        assert: (c) => {
            if (!c.writePaths.find(p => p.path === "/project/data")) throw new Error("Missing write");
            if (!c.readPaths.find(p => p.path === "/project/data")) throw new Error("Write must imply read");
        },
    },
    {
        name: "tempDir is readable and writable",
        permissions: {},
        assert: (c) => {
            if (!c.readPaths.find(p => p.path === "/tmp/webrun")) throw new Error("tempDir must be readable");
            if (!c.writePaths.find(p => p.path === "/tmp/webrun")) throw new Error("tempDir must be writable");
        },
    },
    {
        name: "linux system read paths included",
        permissions: {},
        os: "linux",
        assert: (c) => {
            for (const p of SYSTEM_READ_PATHS.linux) {
                if (!c.readPaths.find(cp => cp.path === p.path)) throw new Error(`Missing system path: ${p.path}`);
            }
        },
    },
    {
        name: "darwin system read paths included",
        permissions: {},
        os: "darwin",
        assert: (c) => {
            for (const p of SYSTEM_READ_PATHS.darwin) {
                if (!c.readPaths.find(cp => cp.path === p.path)) throw new Error(`Missing system path: ${p.path}`);
            }
        },
    },
    {
        name: "bundle protectedPaths are readable",
        permissions: {},
        assert: (c) => {
            if (!c.readPaths.find(p => p.path === "/opt/webrun")) throw new Error("Bundle paths must be readable");
        },
    },
    {
        name: "canonicalize applied to tempDir",
        permissions: {},
        tempDir: "/var/tmp",
        canonicalize: (p) => p === "/var/tmp" ? "/private/var/tmp" : p,
        assert: (c) => {
            if (!c.readPaths.find(p => p.path === "/private/var/tmp")) throw new Error("Canonicalized tempDir missing");
            if (c.readPaths.find(p => p.path === "/var/tmp")) throw new Error("Raw tempDir should not appear");
        },
    },
    {
        name: "binaries populate execPaths and readPaths",
        permissions: { binaries: [["/usr/bin/git"]] },
        assert: (c) => {
            if (!c.execPaths.find(p => p.path === "/usr/bin/git")) throw new Error("Binary not in execPaths");
            if (!c.readPaths.find(p => p.path === "/usr/bin/git")) throw new Error("Binary not in readPaths");
        },
    },
    {
        name: "network permissions flow through",
        permissions: { network: ["example.com"] },
        assert: (c) => {
            if (!c.remoteNetworkConnectHosts.includes("example.com")) throw new Error("Missing network host");
        },
    },
    {
        name: "ports flow to local connect and bind",
        permissions: {},
        ports: [38291],
        assert: (c) => {
            if (!c.localNetworkConnectPorts.includes(38291)) throw new Error("Missing connect port");
            if (!c.localNetworkBindPorts.includes(38291)) throw new Error("Missing bind port");
        },
    },
    {
        name: "env permissions flow through",
        permissions: { env: ["HOME", "PATH"] },
        assert: (c) => {
            if (c.env === "*") return;
            if (!c.env.includes("HOME")) throw new Error("Missing HOME");
        },
    },
    {
        name: "import hosts flow through",
        permissions: { import: ["esm.sh:443"] },
        assert: (c) => {
            if (!c.importHosts.includes("esm.sh:443")) throw new Error("Missing import host");
        },
    },
    {
        name: "run permission populates runPaths with execPath",
        permissions: { run: true },
        assert: (c) => {
            if (!c.run) throw new Error("run should be true");
            if (!c.runPaths.includes("/usr/bin/deno")) throw new Error("runPaths should include execPath");
        },
    },
    {
        name: "no run permission leaves runPaths empty",
        permissions: {},
        assert: (c) => {
            if (c.runPaths.length !== 0) throw new Error("runPaths should be empty");
        },
    },
];

export async function testResolveCapabilities(t: any) {
    for (const tc of capsCases) {
        await t.run(tc.name, async () => {
            const caps = resolveCapabilities({
                permissions: tc.permissions,
                bundle: BUNDLE,
                mode: "module",
                os: tc.os || "linux",
                serve: (tc.ports || []).map(p => ({ port: p, host: "127.0.0.1" })),
                dir: tc.dir || "/project",
                tempDir: tc.tempDir || "/tmp/webrun",
                canonicalize: tc.canonicalize || identity,
            });
            tc.assert(caps);
        });
    }
}

// ── augmentForJail: table-driven ──

function makeCaps(overrides: any = {}): ResolvedCapabilities {
    const mapPaths = (paths: string[] | undefined) => paths?.map(p => ({ path: p, optional: false }));
    return {
        env: [],
        gpu: false,
        ffi: false,
        localNetworkConnectPorts: [],
        localNetworkBindPorts: [],
        remoteNetworkConnectHosts: [],
        remoteNetworkBindHosts: [],
        importHosts: [],
        run: false,
        runPaths: [],
        outboundSocketPaths: [],
        ...overrides,
        readPaths: mapPaths(overrides.readPaths) || [{ path: "/project", optional: false }],
        writePaths: mapPaths(overrides.writePaths) || [{ path: "/tmp/webrun", optional: false }],
        execPaths: mapPaths(overrides.execPaths) || [{ path: "/usr/bin/deno", optional: false }],
    };
}

const augmentCases: {
    name: string;
    caps: ResolvedCapabilities;
    assert: (result: { augmented: ResolvedCapabilities; drop: Partial<ResolvedCapabilities> }) => void;
}[] = [
    {
        name: "guest without FFI: augmented gets FFI, drop has ffi=false",
        caps: makeCaps({ ffi: false }),
        assert: ({ augmented, drop }) => {
            if (!augmented.ffi) throw new Error("augmented.ffi should be true");
            if (drop.ffi !== false) throw new Error("drop.ffi should be false");
        },
    },
    {
        name: "guest with FFI: augmented keeps FFI, drop has no ffi key",
        caps: makeCaps({ ffi: true }),
        assert: ({ augmented, drop }) => {
            if (!augmented.ffi) throw new Error("augmented.ffi should be true");
            if ("ffi" in drop) throw new Error("drop should not have ffi key");
        },
    },
    {
        name: "non-FFI fields pass through unchanged",
        caps: makeCaps({ readPaths: ["/a", "/b"], gpu: true }),
        assert: ({ augmented }) => {
            if (augmented.readPaths.length !== 2) throw new Error("readPaths should pass through");
            if (!augmented.gpu) throw new Error("gpu should pass through");
        },
    },
    {
        name: "guest without run: drop has run=false",
        caps: makeCaps({ run: false }),
        assert: ({ drop }) => {
            if (drop.run !== false) throw new Error("drop.run should be false");
        },
    },
    {
        name: "guest with run: drop has no run key",
        caps: makeCaps({ run: true }),
        assert: ({ drop }) => {
            if ("run" in drop) throw new Error("drop should not have run key");
        },
    },
];

export async function testAugmentForJail(t: any) {
    for (const tc of augmentCases) {
        await t.run(tc.name, async () => tc.assert(augmentForJail(tc.caps)));
    }
}
