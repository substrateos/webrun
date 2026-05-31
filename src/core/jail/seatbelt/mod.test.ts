import { toSeatbeltPolicy, toSeatbeltEnclaves } from "./mod.ts";
import type { ResolvedCapabilities } from "../../capabilities.ts";

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

function extractRules(profile: string, direction: "remote" | "local"): string[] {
    const re = new RegExp(`\\(${direction} (?:tcp|udp) "[^"]+"\\)`, "g");
    return [...profile.matchAll(re)].map(m => m[0]);
}

// ── toSeatbeltPolicy: network rules ──

const networkCases: {
    name: string;
    caps: ResolvedCapabilities;
    assert: (profile: string) => void;
}[] = [
    {
        name: "no network: only DNS outbound",
        caps: makeCaps(),
        assert: (profile) => {
            const out = extractRules(profile, "remote");
            if (!out.some(r => r.includes('udp "*:53"'))) throw new Error("DNS baseline missing");
            if (out.filter(r => !r.includes('"*:53"')).length > 0) throw new Error("Unexpected non-DNS outbound");
        },
    },
    {
        name: "network hosts open TCP/UDP *:*",
        caps: makeCaps({ remoteNetworkConnectHosts: ["example.com"] }),
        assert: (profile) => {
            const out = extractRules(profile, "remote");
            const inb = extractRules(profile, "local");
            if (!out.some(r => r === '(remote tcp "*:*")')) throw new Error("Missing TCP *:* outbound");
            if (!out.some(r => r === '(remote udp "*:*")')) throw new Error("Missing UDP *:* outbound");
            if (!inb.some(r => r === '(local tcp "*:*")')) throw new Error("Missing TCP *:* inbound");
            if (!inb.some(r => r === '(local udp "*:*")')) throw new Error("Missing UDP *:* inbound");
        },
    },
    {
        name: "DNS always present with network",
        caps: makeCaps({ remoteNetworkConnectHosts: ["example.com"] }),
        assert: (profile) => {
            if (!profile.includes('(remote udp "*:53")')) throw new Error("DNS missing");
            if (!profile.includes("mDNSResponder")) throw new Error("mDNSResponder missing");
        },
    },
    {
        name: "ephemeral ports → localhost TCP rules",
        caps: makeCaps({ localNetworkConnectPorts: [38291] }),
        assert: (profile) => {
            if (!extractRules(profile, "remote").some(r => r === '(remote tcp "localhost:38291")'))
                throw new Error("Missing ephemeral port rule");
        },
    },
    {
        name: "no ports, no network → no TCP/UDP beyond DNS",
        caps: makeCaps(),
        assert: (profile) => {
            const out = extractRules(profile, "remote");
            if (out.some(r => r.includes("tcp"))) throw new Error("Unexpected TCP");
            if (out.some(r => r.includes("udp") && !r.includes('"*:53"'))) throw new Error("Unexpected UDP");
        },
    },
    {
        name: "only * and localhost as seatbelt hosts",
        caps: makeCaps({ remoteNetworkConnectHosts: ["example.com"] }),
        assert: (profile) => {
            for (const rule of [...extractRules(profile, "remote"), ...extractRules(profile, "local")]) {
                const m = rule.match(/"([^"]+):/);
                if (m && m[1] !== "*" && m[1] !== "localhost")
                    throw new Error(`Invalid host "${m[1]}" in: ${rule}`);
            }
        },
    },
];

// ── toSeatbeltEnclaves + profile structure ──

const structureCases: {
    name: string;
    caps: ResolvedCapabilities;
    assert: (profile: string) => void;
}[] = [
    {
        name: "read paths → subpath enclaves",
        caps: makeCaps({ readPaths: ["/project/src", "/usr/lib"] }),
        assert: (profile) => {
            if (!profile.includes('(subpath "/project/src")')) throw new Error("Missing read enclave");
            if (!profile.includes('(subpath "/usr/lib")')) throw new Error("Missing read enclave");
        },
    },
    {
        name: "write paths → subpath enclaves",
        caps: makeCaps({ writePaths: ["/tmp/webrun", "/project/data"] }),
        assert: (profile) => {
            if (!profile.includes('(subpath "/tmp/webrun")')) throw new Error("Missing write enclave");
            if (!profile.includes('(subpath "/project/data")')) throw new Error("Missing write enclave");
        },
    },
    {
        name: "GPU enables iokit-open and var/folders",
        caps: makeCaps({ gpu: true }),
        assert: (profile) => {
            if (!profile.includes("iokit-open")) throw new Error("Missing iokit-open");
            if (!profile.includes("private/var/folders")) throw new Error("Missing var/folders regex");
        },
    },
    {
        name: ".env files always denied",
        caps: makeCaps(),
        assert: (profile) => {
            if (!profile.includes(".env")) throw new Error("Must deny .env access");
        },
    },
    {
        name: "file paths use literal, not subpath",
        caps: makeCaps({ readPaths: ["/project/webrun.ts", "/project/README.md", "/project/src"] }),
        assert: (profile) => {
            if (!profile.includes('(literal "/project/webrun.ts")')) throw new Error("File should use literal");
            if (!profile.includes('(literal "/project/README.md")')) throw new Error("File should use literal");
            if (!profile.includes('(subpath "/project/src")')) throw new Error("Directory should use subpath");
        },
    },
    {
        name: "system paths not duplicated in enclaves",
        caps: makeCaps({ readPaths: ["/dev/random", "/dev/null", "/project"] }),
        assert: (profile) => {
            const { readEnclaves } = toSeatbeltEnclaves(makeCaps({ readPaths: ["/dev/random", "/dev/null", "/project"] }));
            if (readEnclaves.includes("/dev/random")) throw new Error("/dev/random should not appear in enclaves");
            if (readEnclaves.includes("/dev/null")) throw new Error("/dev/null should not appear in enclaves");
            if (!readEnclaves.includes("/project")) throw new Error("/project should appear in enclaves");
        },
    },
];

export async function testSeatbeltNetworkPolicy(t: any) {
    for (const tc of networkCases) {
        await t.run(tc.name, async () => tc.assert(toSeatbeltPolicy(tc.caps)));
    }
}

export async function testSeatbeltStructure(t: any) {
    for (const tc of structureCases) {
        await t.run(tc.name, async () => tc.assert(toSeatbeltPolicy(tc.caps)));
    }
}

