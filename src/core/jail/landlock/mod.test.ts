import { toLandlockPolicy, type LandlockPolicy } from "./mod.ts";
import { SYSTEM_READ_PATHS, type ResolvedCapabilities } from "../../capabilities.ts";

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
    assert: (p: LandlockPolicy) => void;
}[] = [
    {
        name: "read_paths passed through",
        caps: makeCaps({ readPaths: ["/project/src", "/usr/lib"] }),
        assert: (p) => {
            if (!p.read_paths.find(p => p.path === "/project/src")) throw new Error("Missing /project/src");
            if (!p.read_paths.find(p => p.path === "/usr/lib")) throw new Error("Missing /usr/lib");
        },
    },
    {
        name: "write_paths passed through",
        caps: makeCaps({ writePaths: ["/project/data"] }),
        assert: (p) => {
            if (!p.write_paths.find(p => p.path === "/project/data")) throw new Error("Missing write path");
        },
    },
    {
        name: "exec_paths contains runtime binary",
        caps: makeCaps(),
        assert: (p) => {
            if (!p.exec_paths.find(p => p.path === "/usr/bin/deno")) throw new Error("Missing deno");
        },
    },
    {
        name: "system library exec paths present",
        caps: makeCaps({ execPaths: ["/usr/bin/deno", "/usr/lib", "/lib"] }),
        assert: (p) => {
            if (!p.exec_paths.find(p => p.path === "/usr/lib")) throw new Error("Missing /usr/lib");
            if (!p.exec_paths.find(p => p.path === "/lib")) throw new Error("Missing /lib");
        },
    },
    {
        name: "local bind ports flow to tcp_bind_ports",
        caps: makeCaps({ localNetworkBindPorts: [45000] }),
        assert: (p) => {
            if (!p.tcp_bind_ports!.includes(45000)) throw new Error("Missing bind port");
        },
    },
    {
        name: "remoteNetworkBindHosts → unrestricted tcp_bind_ports",
        caps: makeCaps({ remoteNetworkBindHosts: ["127.0.0.1"] }),
        assert: (p) => {
            if (p.tcp_bind_ports !== null) throw new Error("Expected null tcp_bind_ports for bind hosts");
        },
    },
    {
        name: "local connect ports flow to tcp_connect_ports",
        caps: makeCaps({ localNetworkConnectPorts: [38291] }),
        assert: (p) => {
            if (!p.tcp_connect_ports?.includes(38291)) throw new Error("Missing connect port");
        },
    },
    {
        name: "network hosts add well-known ports 80/443",
        caps: makeCaps({ remoteNetworkConnectHosts: ["example.com"] }),
        assert: (p) => {
            if (!p.tcp_connect_ports?.includes(80)) throw new Error("Missing 80");
            if (!p.tcp_connect_ports?.includes(443)) throw new Error("Missing 443");
        },
    },
    {
        name: "no network hosts → no 80/443",
        caps: makeCaps(),
        assert: (p) => {
            if (p.tcp_connect_ports?.includes(80)) throw new Error("Unexpected 80");
            if (p.tcp_connect_ports?.includes(443)) throw new Error("Unexpected 443");
        },
    },
    {
        name: "GPU flag propagates true",
        caps: makeCaps({ gpu: true }),
        assert: (p) => { if (!p.gpu) throw new Error("gpu should be true"); },
    },
    {
        name: "GPU flag defaults false",
        caps: makeCaps(),
        assert: (p) => { if (p.gpu) throw new Error("gpu should be false"); },
    },
];

export async function testToLandlockPolicy(t: any) {
    for (const tc of cases) {
        await t.run(`toLandlockPolicy: ${tc.name}`, async () => {
            tc.assert(toLandlockPolicy(tc.caps));
        });
    }
}
