import { dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { buildJailConfig, buildLandlockPolicy, buildSubcommand, buildNetworkFlags, generateSeatbeltProfile, SYSTEM_READ_PATHS } from "../src/jail.ts";
import { computeOpfsPathId } from "../src/host.ts";
import { evaluateEnclavePolicy } from "../src/policy.ts";

// Mock JailRuntime for pure-function testing (no I/O).
function mockSys(overrides: Partial<{ execPath: string; realPathSync: (p: string) => string }> = {}) {
    return {
        execPath: () => overrides.execPath || "/usr/bin/deno",
        Command: class {} as any,
        realPathSync: overrides.realPathSync || ((p: string) => p),
    };
}

function mockPolicy(overrides: Partial<{
    allowedReadPaths: string[];
    allowedWritePaths: string[];
    allowedBindings: string[];
    isPwdAllowed: boolean;
    fallbackToTemp: boolean;
    storageRoot: string;
}> = {}) {
    return {
        isPwdAllowed: overrides.isPwdAllowed ?? true,
        fallbackToTemp: overrides.fallbackToTemp ?? false,
        storageRoot: overrides.storageRoot || "/project",
        allowedReadPaths: overrides.allowedReadPaths || [],
        allowedWritePaths: overrides.allowedWritePaths || [],
        allowedBindings: overrides.allowedBindings || [],
    };
}

const DEFAULT_PATHS = {
    projectRoot: "/project",
    cwd: "/project",
    localCacheDir: "/cache/webrun",
    isolatedTmp: "/tmp/webrun-isolated",
    runnerTmp: "/tmp/webrun-runner",
    opfsTmp: "/tmp/webrun-opfs",
    bindingSdksTmp: "/tmp/webrun-bindings",
    webrunEntryPath: "/opt/webrun/webrun.ts",
};

export async function testJailDispatch(t: any) {
    // ── T0: buildJailConfig dispatch ──

    await t.run("buildJailConfig dispatches to seatbelt on darwin", async () => {
        const sys = mockSys();
        const policy = mockPolicy();
        const result = buildJailConfig(sys, "darwin", policy, ["run", "main.ts"], DEFAULT_PATHS, [], false);
        if (result.baseCmd !== "/usr/bin/sandbox-exec") {
            throw new Error(`Expected baseCmd /usr/bin/sandbox-exec, got ${result.baseCmd}`);
        }
        if (!result.execArgs.includes("-p")) {
            throw new Error("Expected execArgs to contain -p (seatbelt profile)");
        }
        if (result.landlockPolicy !== undefined) {
            throw new Error("Expected no landlockPolicy on darwin");
        }
    });

    await t.run("buildJailConfig dispatches to Landlock on linux", async () => {
        const sys = mockSys();
        const policy = mockPolicy();
        const result = buildJailConfig(sys, "linux", policy, ["run", "main.ts"], DEFAULT_PATHS, [], false);
        if (result.baseCmd !== "/usr/bin/deno") {
            throw new Error(`Expected baseCmd to be deno, got ${result.baseCmd}`);
        }
        if (result.landlockPolicy === undefined) {
            throw new Error("Expected landlockPolicy to be set on linux");
        }
        if (!Array.isArray(result.landlockPolicy.read_paths)) {
            throw new Error("Expected landlockPolicy.read_paths to be an array");
        }
    });

    await t.run("buildJailConfig passes through on self-test (none)", async () => {
        const sys = mockSys();
        const policy = mockPolicy();
        const args = ["run", "main.ts"];
        const result = buildJailConfig(sys, "none", policy, args, DEFAULT_PATHS, [], false);
        if (result.baseCmd !== "/usr/bin/deno") {
            throw new Error(`Expected baseCmd to be deno, got ${result.baseCmd}`);
        }
        if (JSON.stringify(result.execArgs) !== JSON.stringify(args)) {
            throw new Error("Expected execArgs to be unchanged in passthrough mode");
        }
        if (result.landlockPolicy !== undefined) {
            throw new Error("Expected no landlockPolicy in passthrough mode");
        }
    });

    await t.run("buildJailConfig passes through on unknown OS", async () => {
        const sys = mockSys();
        const policy = mockPolicy();
        const result = buildJailConfig(sys, "freebsd", policy, ["run", "main.ts"], DEFAULT_PATHS, [], false);
        if (result.baseCmd !== "/usr/bin/deno") {
            throw new Error(`Expected baseCmd to be deno, got ${result.baseCmd}`);
        }
        if (result.landlockPolicy !== undefined) {
            throw new Error("Expected no landlockPolicy on unknown OS");
        }
    });

    // ── T1: buildLandlockPolicy table-driven tests ──

    const policyTests = [
        {
            name: "includes user read paths",
            policy: mockPolicy({ allowedReadPaths: ["/home/user/project/src"] }),
            expect: (p: any) => p.read_paths.includes("/home/user/project/src"),
        },
        {
            name: "includes user write paths",
            policy: mockPolicy({ allowedWritePaths: ["/home/user/project/data"] }),
            expect: (p: any) => p.write_paths.includes("/home/user/project/data"),
        },
        {
            name: "exec_paths contains only the runtime binary",
            policy: mockPolicy(),
            expect: (p: any) => p.exec_paths.length === 1 && p.exec_paths[0] === "/usr/bin/deno",
        },
        {
            name: "system library paths always present",
            policy: mockPolicy(),
            expect: (p: any) => ["/usr/lib", "/lib", "/etc/resolv.conf", "/etc/hosts"].every(
                (s: string) => p.read_paths.includes(s)
            ),
        },
        {
            name: "mux port in tcp_bind_ports",
            policy: mockPolicy(),
            ephemeralPorts: [45000],
            expect: (p: any) => p.tcp_bind_ports.includes(45000) && p.tcp_bind_ports.length === 1,
        },
        {
            name: "tcp_connect_ports includes 80 and 443 for defense-in-depth",
            policy: mockPolicy(),
            expect: (p: any) => p.tcp_connect_ports.includes(80) && p.tcp_connect_ports.includes(443),
        },
        {
            name: "GPU flag propagates",
            policy: mockPolicy(),
            allowGpu: true,
            expect: (p: any) => p.gpu === true,
        },
        {
            name: "GPU flag defaults to false",
            policy: mockPolicy(),
            expect: (p: any) => p.gpu === false,
        },
        {
            name: "runtime binary dir is readable",
            policy: mockPolicy(),
            expect: (p: any) => p.read_paths.includes(dirname("/usr/bin/deno")),
        },
        {
            name: "webrun entry path is readable",
            policy: mockPolicy(),
            expect: (p: any) => p.read_paths.includes("/opt/webrun/webrun.ts"),
        },
        {
            name: "source directory readable when entry ends in .ts",
            policy: mockPolicy(),
            paths: { ...DEFAULT_PATHS, webrunEntryPath: "/opt/webrun/webrun.ts" },
            expect: (p: any) => p.read_paths.includes("/opt/webrun"),
        },
        {
            name: "source directory NOT readable when entry is bundled",
            policy: mockPolicy(),
            paths: { ...DEFAULT_PATHS, webrunEntryPath: "/opt/webrun/webrun" },
            expect: (p: any) => !p.read_paths.includes("/opt/webrun"),
        },
        {
            name: "isolatedTmp is writable",
            policy: mockPolicy(),
            expect: (p: any) => p.write_paths.includes("/tmp/webrun-isolated"),
        },
        {
            name: "runnerTmp is both readable and writable",
            policy: mockPolicy(),
            expect: (p: any) => p.read_paths.includes("/tmp/webrun-runner") && p.write_paths.includes("/tmp/webrun-runner"),
        },
        {
            name: "opfsTmp is writable",
            policy: mockPolicy(),
            expect: (p: any) => p.write_paths.includes("/tmp/webrun-opfs"),
        },
        {
            name: "localCacheDir is both readable and writable",
            policy: mockPolicy(),
            expect: (p: any) => p.read_paths.includes("/cache/webrun") && p.write_paths.includes("/cache/webrun"),
        },
        {
            name: "system deps match SYSTEM_READ_PATHS.linux entries",
            policy: mockPolicy(),
            expect: (p: any) => SYSTEM_READ_PATHS.linux.every((s: string) => p.read_paths.includes(s)),
        },
        {
            name: "paths are canonicalized through realPathSync",
            policy: mockPolicy({ allowedReadPaths: ["/tmp/symlinked"] }),
            sysOverrides: { realPathSync: (p: string) => p === "/tmp/symlinked" ? "/real/path" : p },
            expect: (p: any) => p.read_paths.includes("/real/path") && !p.read_paths.includes("/tmp/symlinked"),
        },
    ];

    for (const test of policyTests) {
        await t.run(`buildLandlockPolicy: ${test.name}`, async () => {
            const sys = mockSys((test as any).sysOverrides || {});
            const paths = (test as any).paths || DEFAULT_PATHS;
            const ephemeralPorts = (test as any).ephemeralPorts || [];
            const allowGpu = (test as any).allowGpu || false;
            const result = buildLandlockPolicy(sys, test.policy, paths, ephemeralPorts, allowGpu);
            if (!test.expect(result)) {
                throw new Error(`Assertion failed for "${test.name}"\nPolicy: ${JSON.stringify(result, null, 2)}`);
            }
        });
    }
}

export async function testBuildSubcommand(t: any) {
    const cases = [
        { action: "eval", expected: "run" },
        { action: "serve", expected: "run" },
        { action: "check-only", expected: "check" },
        { action: "test", expected: "run" },
        { action: "run", expected: "run" },
    ];

    for (const { action, expected } of cases) {
        await t.run(`buildSubcommand: "${action}" → "${expected}"`, async () => {
            const result = buildSubcommand(action);
            if (result !== expected) {
                throw new Error(`Expected "${expected}", got "${result}"`);
            }
        });
    }
}

export async function testBuildNetworkFlags(t: any) {
    const cases = [
        {
            name: "no flags, no ports → empty",
            rawFlags: [] as string[],
            serves: undefined as { host: string; port: number }[] | undefined,
            ports: [] as number[],
            expect: (r: string[]) => r.length === 0,
        },
        {
            name: "--deny-net + ephemeral ports → allow only those ports",
            rawFlags: ["--deny-net"],
            serves: undefined,
            ports: [38291],
            expect: (r: string[]) => {
                const flag = r.find(f => f.startsWith("--allow-net="));
                return !!flag && flag.includes("127.0.0.1:38291") && !r.includes("--deny-net");
            },
        },
        {
            name: "--allow-net passthrough when present (bare)",
            rawFlags: ["--allow-net"],
            serves: [{ host: "0.0.0.0", port: 8080 }],
            ports: [],
            expect: (r: string[]) => r.includes("--allow-net"),
        },
        {
            name: "--allow-net=host passthrough merges with ports",
            rawFlags: ["--allow-net=example.com:443"],
            serves: undefined,
            ports: [9999],
            expect: (r: string[]) => {
                const flag = r.find(f => f.startsWith("--allow-net="));
                return !!flag && flag.includes("example.com:443") && flag.includes("127.0.0.1:9999");
            },
        },
        {
            name: "serve interfaces + ephemeral ports both appear",
            rawFlags: [],
            serves: [{ host: "0.0.0.0", port: 3000 }],
            ports: [45000],
            expect: (r: string[]) => {
                const flag = r.find(f => f.startsWith("--allow-net="));
                return !!flag && flag.includes("0.0.0.0:3000") && flag.includes("127.0.0.1:45000");
            },
        },
        {
            name: "no ports, no serves → flags unchanged",
            rawFlags: ["--deny-net"],
            serves: undefined,
            ports: [],
            expect: (r: string[]) => {
                // With no ports to allow, bare --deny-net passes through unchanged
                return r.includes("--deny-net");
            },
        },
    ];

    for (const tc of cases) {
        await t.run(`buildNetworkFlags: ${tc.name}`, async () => {
            const result = buildNetworkFlags(tc.rawFlags, tc.serves, tc.ports);
            if (!tc.expect(result)) {
                throw new Error(`Assertion failed\nResult: ${JSON.stringify(result)}`);
            }
        });
    }
}

export async function testComputeOpfsPathId(t: any) {
    const cases = [
        {
            name: "deterministic: same input → same output",
            expect: () => computeOpfsPathId("/home/user/project") === computeOpfsPathId("/home/user/project"),
        },
        {
            name: "URL-safe: no slashes, plus, or equals",
            expect: () => {
                const id = computeOpfsPathId("/home/user/project/with/deep/nesting");
                return !id.includes("/") && !id.includes("+") && !id.includes("=");
            },
        },
        {
            name: "non-empty for valid path",
            expect: () => computeOpfsPathId("/tmp").length > 0,
        },
        {
            name: "distinct paths → distinct IDs",
            expect: () => computeOpfsPathId("/home/a") !== computeOpfsPathId("/home/b"),
        },
        {
            name: "handles paths with special characters",
            expect: () => {
                const id = computeOpfsPathId("/home/user/my project (2)/src");
                return id.length > 0 && !id.includes("/") && !id.includes("+") && !id.includes("=");
            },
        },
    ];

    for (const tc of cases) {
        await t.run(`computeOpfsPathId: ${tc.name}`, async () => {
            if (!tc.expect()) {
                throw new Error(`Assertion failed for "${tc.name}"`);
            }
        });
    }
}

export async function testHomePathContainment(t: any) {
    // ~ is a valid directory name character. webrun does NOT expand it.
    // resolve() treats it literally, so "~/.ssh" → "<configDir>/~/.ssh" — contained.
    // The containment check blocks actual traversals and absolute paths outside configDir.

    const blockedCases = [
        {
            name: "relative traversal is blocked",
            configDirs: { "../../etc": { access: "read" as const } },
        },
        {
            name: "absolute path outside configDir is blocked",
            configDirs: { "/var/log": { access: "read" as const } },
        },
    ];

    for (const tc of blockedCases) {
        await t.run(`evaluateEnclavePolicy: ${tc.name}`, async () => {
            let exitCalled = false;
            const mockSys = {
                env: { get: () => undefined },
                exit: () => { exitCalled = true; },
                readTextFileSync: () => "",
                statSync: () => ({ isFile: true }),
                writeTextFileSync: () => {},
                realPathSync: (p: string) => p,
            } as any;

            evaluateEnclavePolicy(
                mockSys, tc.configDirs, [], "/project", "/project", "/tmp/isolated"
            );

            if (!exitCalled) {
                throw new Error(
                    `evaluateEnclavePolicy should have called exit() — ` +
                    `the containment check must block paths outside configDir`
                );
            }
        });
    }

    // ~ treated literally — resolves within configDir, no expansion
    await t.run("evaluateEnclavePolicy: ~/path is treated literally (no expansion)", async () => {
        let exitCalled = false;
        const mockSys = {
            env: { get: () => undefined },
            exit: () => { exitCalled = true; },
            readTextFileSync: () => "",
            statSync: () => ({ isFile: true }),
            writeTextFileSync: () => {},
            realPathSync: (p: string) => p,
        } as any;

        const policy = evaluateEnclavePolicy(
            mockSys, { "~/.ssh": { access: "read" } }, [], "/project", "/project", "/tmp/isolated"
        );

        if (exitCalled) {
            throw new Error("~/path should not be rejected — ~ is a literal path character");
        }
        if (!policy.allowedReadPaths.includes("/project/~/.ssh")) {
            throw new Error(
                `Expected /project/~/.ssh in allowedReadPaths (literal ~), ` +
                `got: [${policy.allowedReadPaths.join(", ")}]`
            );
        }
    });
}

export async function testSeatbeltNetworkPolicy(t: any) {
    // Helper: extract all `(remote ...)` and `(local ...)` network rules from a profile.
    function extractRules(profile: string, direction: "remote" | "local"): string[] {
        const re = new RegExp(`\\(${direction} (?:tcp|udp) "[^"]+"\\)`, "g");
        return [...profile.matchAll(re)].map(m => m[0]);
    }

    const cases = [
        {
            name: "no network: no TCP/UDP outbound beyond DNS",
            hasNetwork: false,
            expect: (profile: string) => {
                const outbound = extractRules(profile, "remote");
                if (!outbound.some(r => r.includes('udp "*:53"'))) {
                    throw new Error("DNS baseline missing");
                }
                const nonDns = outbound.filter(r => !r.includes('"*:53"'));
                if (nonDns.length > 0) {
                    throw new Error(`Unexpected outbound rules without network: ${nonDns.join(", ")}`);
                }
            },
        },
        {
            name: "hasNetwork: opens TCP and UDP to *:*",
            hasNetwork: true,
            expect: (profile: string) => {
                const outbound = extractRules(profile, "remote");
                if (!outbound.some(r => r === '(remote tcp "*:*")')) {
                    throw new Error("Missing TCP *:* outbound");
                }
                if (!outbound.some(r => r === '(remote udp "*:*")')) {
                    throw new Error("Missing UDP *:* outbound");
                }
                const inbound = extractRules(profile, "local");
                if (!inbound.some(r => r === '(local tcp "*:*")')) {
                    throw new Error("Missing TCP *:* inbound");
                }
                if (!inbound.some(r => r === '(local udp "*:*")')) {
                    throw new Error("Missing UDP *:* inbound");
                }
            },
        },
        {
            name: "DNS baseline always present regardless of network flag",
            hasNetwork: true,
            expect: (profile: string) => {
                if (!profile.includes('(remote udp "*:53")')) {
                    throw new Error("DNS baseline missing");
                }
                if (!profile.includes("mDNSResponder")) {
                    throw new Error("mDNSResponder baseline missing");
                }
            },
        },
        {
            name: "ephemeral ports generate localhost TCP rules independent of network flag",
            hasNetwork: false,
            ephemeralPorts: [38291],
            expect: (profile: string) => {
                const outbound = extractRules(profile, "remote");
                if (!outbound.some(r => r === '(remote tcp "localhost:38291")')) {
                    throw new Error("Missing TCP rule for ephemeral port");
                }
            },
        },
        {
            name: "no spurious TCP/UDP without network or ephemeral ports",
            hasNetwork: false,
            ephemeralPorts: [],
            expect: (profile: string) => {
                const outbound = extractRules(profile, "remote");
                const tcpRules = outbound.filter(r => r.includes("tcp"));
                if (tcpRules.length > 0) {
                    throw new Error(`Unexpected TCP outbound rules: ${tcpRules.join(", ")}`);
                }
                const udpRules = outbound.filter(r => r.includes("udp") && !r.includes('"*:53"'));
                if (udpRules.length > 0) {
                    throw new Error(`Unexpected UDP outbound rules: ${udpRules.join(", ")}`);
                }
            },
        },
        {
            name: "only uses * and localhost as seatbelt host values (no IPs or hostnames)",
            hasNetwork: true,
            expect: (profile: string) => {
                // The seatbelt DSL only accepts * or localhost as host values.
                // Verify no IP addresses or domain names appear in network rules.
                const allRules = [...extractRules(profile, "remote"), ...extractRules(profile, "local")];
                for (const rule of allRules) {
                    const hostMatch = rule.match(/"([^"]+):/);
                    if (hostMatch) {
                        const host = hostMatch[1];
                        if (host !== "*" && host !== "localhost") {
                            throw new Error(`Invalid seatbelt host "${host}" in rule: ${rule}. Only * and localhost are valid.`);
                        }
                    }
                }
            },
        },
    ];

    for (const tc of cases) {
        await t.run(`generateSeatbeltProfile: ${tc.name}`, async () => {
            const profile = generateSeatbeltProfile(
                "/project", "", "",
                (tc as any).ephemeralPorts || [],
                false,
                tc.hasNetwork,
            );
            tc.expect(profile);
        });
    }
}
