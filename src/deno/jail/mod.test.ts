import toDenoFlags, { toDenoPermissionsObject } from "./mod.ts";
import type { ResolvedCapabilities } from "../../core/capabilities.ts";

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

const cases: {
    name: string;
    caps: ResolvedCapabilities;
    assert: (flags: string[]) => void;
}[] = [
    {
        name: "read paths → --allow-read",
        caps: makeCaps({ readPaths: ["/project", "/usr/lib"] }),
        assert: (f) => {
            const flag = f.find(x => x.startsWith("--allow-read="));
            if (!flag) throw new Error("Missing --allow-read");
            if (!flag.includes("/project")) throw new Error("Missing /project");
            if (!flag.includes("/usr/lib")) throw new Error("Missing /usr/lib");
        },
    },
    {
        name: "write paths → --allow-write",
        caps: makeCaps({ writePaths: ["/tmp/webrun"] }),
        assert: (f) => {
            const flag = f.find(x => x.startsWith("--allow-write="));
            if (!flag) throw new Error("Missing --allow-write");
            if (!flag.includes("/tmp/webrun")) throw new Error("Missing /tmp/webrun");
        },
    },
    {
        name: "no network → --deny-net",
        caps: makeCaps(),
        assert: (f) => {
            if (!f.includes("--deny-net")) throw new Error("Expected --deny-net");
        },
    },
    {
        name: "remote hosts → --allow-net with hosts",
        caps: makeCaps({ remoteNetworkConnectHosts: ["example.com:443"] }),
        assert: (f) => {
            const flag = f.find(x => x.startsWith("--allow-net="));
            if (!flag) throw new Error("Missing --allow-net");
            if (!flag.includes("example.com:443")) throw new Error("Missing host");
        },
    },
    {
        name: "wildcard network → bare --allow-net",
        caps: makeCaps({ remoteNetworkConnectHosts: ["*"] }),
        assert: (f) => {
            if (!f.includes("--allow-net")) throw new Error("Expected --allow-net");
        },
    },
    {
        name: "local ports → --allow-net with 127.0.0.1:port",
        caps: makeCaps({ localNetworkConnectPorts: [38291] }),
        assert: (f) => {
            const flag = f.find(x => x.startsWith("--allow-net="));
            if (!flag) throw new Error("Missing --allow-net");
            if (!flag.includes("127.0.0.1:38291")) throw new Error("Missing localhost port");
        },
    },
    {
        name: "env vars → --allow-env",
        caps: makeCaps({ env: ["HOME", "PATH"] }),
        assert: (f) => {
            const flag = f.find(x => x.startsWith("--allow-env="));
            if (!flag) throw new Error("Missing --allow-env");
            if (!flag.includes("HOME")) throw new Error("Missing HOME");
        },
    },
    {
        name: "wildcard env → bare --allow-env",
        caps: makeCaps({ env: "*" }),
        assert: (f) => {
            if (!f.includes("--allow-env")) throw new Error("Expected --allow-env");
        },
    },
    {
        name: "ffi true → --allow-ffi",
        caps: makeCaps({ ffi: true }),
        assert: (f) => {
            if (!f.includes("--allow-ffi")) throw new Error("Expected --allow-ffi");
        },
    },
    {
        name: "ffi false → no --allow-ffi",
        caps: makeCaps(),
        assert: (f) => {
            if (f.includes("--allow-ffi")) throw new Error("Unexpected --allow-ffi");
        },
    },
    {
        name: "import hosts → --allow-import with hosts",
        caps: makeCaps({ importHosts: ["esm.sh:443", "unpkg.com:443"] }),
        assert: (f) => {
            const flag = f.find(x => x.startsWith("--allow-import="));
            if (!flag) throw new Error("Missing --allow-import");
            if (!flag.includes("esm.sh:443")) throw new Error("Missing esm.sh");
            if (!flag.includes("unpkg.com:443")) throw new Error("Missing unpkg.com");
        },
    },
    {
        name: "wildcard import → bare --allow-import",
        caps: makeCaps({ importHosts: ["*"] }),
        assert: (f) => {
            if (!f.includes("--allow-import")) throw new Error("Expected --allow-import");
            if (f.some(x => x.startsWith("--allow-import="))) throw new Error("Wildcard should be bare");
        },
    },
    {
        name: "no imports → no --allow-import",
        caps: makeCaps(),
        assert: (f) => {
            if (f.some(x => x.includes("--allow-import"))) throw new Error("Unexpected --allow-import");
        },
    },
    {
        name: "runPaths → --allow-run with paths",
        caps: makeCaps({ runPaths: ["/usr/bin/deno"] }),
        assert: (f) => {
            const flag = f.find(x => x.startsWith("--allow-run="));
            if (!flag) throw new Error("Missing --allow-run");
            if (!flag.includes("/usr/bin/deno")) throw new Error("Missing deno path");
        },
    },
    {
        name: "no runPaths → no --allow-run",
        caps: makeCaps(),
        assert: (f) => {
            if (f.some(x => x.includes("--allow-run"))) throw new Error("Unexpected --allow-run");
        },
    },
];

export async function testDenoFlags(t: any) {
    for (const tc of cases) {
        await t.run(tc.name, async () => tc.assert(toDenoFlags(tc.caps)));
    }
}

// ── toDenoPermissionsObject ──

const permObjCases: {
    name: string;
    caps: ResolvedCapabilities;
    assert: (p: Deno.PermissionOptions) => void;
}[] = [
    {
        name: "read paths flow to read array",
        caps: makeCaps({ readPaths: ["/project", "/usr/lib"] }),
        assert: (p) => {
            if (typeof p !== "object" || p === null) throw new Error("Expected object");
            if (!Array.isArray(p.read)) throw new Error("read should be array");
            if (!p.read.includes("/project")) throw new Error("Missing /project");
        },
    },
    {
        name: "no network → net is false",
        caps: makeCaps(),
        assert: (p) => {
            if (typeof p !== "object" || p === null) throw new Error("Expected object");
            if (p.net !== false) throw new Error("net should be false");
        },
    },
    {
        name: "wildcard network → net is true",
        caps: makeCaps({ remoteNetworkConnectHosts: ["*"] }),
        assert: (p) => {
            if (typeof p !== "object" || p === null) throw new Error("Expected object");
            if (p.net !== true) throw new Error("net should be true");
        },
    },
    {
        name: "ffi false → ffi false",
        caps: makeCaps(),
        assert: (p) => {
            if (typeof p !== "object" || p === null) throw new Error("Expected object");
            if (p.ffi !== false) throw new Error("ffi should be false");
        },
    },
    {
        name: "ffi true → ffi true",
        caps: makeCaps({ ffi: true }),
        assert: (p) => {
            if (typeof p !== "object" || p === null) throw new Error("Expected object");
            if (p.ffi !== true) throw new Error("ffi should be true");
        },
    },
    {
        name: "run is always false (Worker never spawns directly)",
        caps: makeCaps(),
        assert: (p) => {
            if (typeof p !== "object" || p === null) throw new Error("Expected object");
            if (p.run !== false) throw new Error("run should be false");
        },
    },
    {
        name: "run is false even when caps.run is true",
        caps: makeCaps({ run: true }),
        assert: (p) => {
            if (typeof p !== "object" || p === null) throw new Error("Expected object");
            if (p.run !== false) throw new Error("run should be false regardless of caps.run");
        },
    },
    {
        name: "import hosts flow to import array",
        caps: makeCaps({ importHosts: ["deno.land:443", "esm.sh:443"] }),
        assert: (p) => {
            if (typeof p !== "object" || p === null) throw new Error("Expected object");
            const imp = (p as any).import;
            if (!Array.isArray(imp)) throw new Error("import should be array");
            if (!imp.includes("deno.land:443")) throw new Error("Missing deno.land:443");
            if (!imp.includes("esm.sh:443")) throw new Error("Missing esm.sh:443");
        },
    },
    {
        name: "wildcard import → import is true",
        caps: makeCaps({ importHosts: ["*"] }),
        assert: (p) => {
            if (typeof p !== "object" || p === null) throw new Error("Expected object");
            if ((p as any).import !== true) throw new Error("import should be true for wildcard");
        },
    },
    {
        name: "no import hosts → import is false",
        caps: makeCaps(),
        assert: (p) => {
            if (typeof p !== "object" || p === null) throw new Error("Expected object");
            if ((p as any).import !== false) throw new Error("import should be false when no importHosts");
        },
    },
];

export async function testDenoPermissionsObject(t: any) {
    for (const tc of permObjCases) {
        await t.run(tc.name, async () => tc.assert(toDenoPermissionsObject(tc.caps)));
    }
}
