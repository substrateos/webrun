import cli from "./cli.ts";
import type { BundleInfo } from "../bundle.ts";
import type { WebrunLimits } from "../types.ts";

const stubBundle: BundleInfo = {
    version: "test",
    main: "/dev/null",
    execPath: "/usr/bin/deno",
    binDir: "/usr/bin",
    sourceDirs: [],
    protectedPaths: [],
};

const stubDeps = {
    bundle: stubBundle,
    console: { log() {}, error() {} },
    exit: (_code: number) => { throw new Error("exit"); },
};

async function parse(args: string[]) {
    return cli(args, {}, stubDeps as any);
}

// ── --limit-time ────────────────────────────────────────────────────

interface LimitTestCase {
    name: string;
    args: string[];
    expect: WebrunLimits;
}

function assertLimits(got: WebrunLimits, expect: WebrunLimits) {
    if (got.timeoutMillis !== expect.timeoutMillis) {
        throw new Error(`Expected timeoutMillis ${expect.timeoutMillis}, got ${got.timeoutMillis}`);
    }
    if (got.memoryMB !== expect.memoryMB) {
        throw new Error(`Expected memoryMB ${expect.memoryMB}, got ${got.memoryMB}`);
    }
}

const limitTimeCases: LimitTestCase[] = [
    { name: "--limit-time=5000 parses as timeoutMillis", args: ["--limit-time=5000", "app.js"], expect: { timeoutMillis: 5000 } },
    { name: "--limit-time=3000", args: ["--limit-time=3000", "app.js"], expect: { timeoutMillis: 3000 } },
    { name: "no --limit-time → empty limits", args: ["app.js"], expect: {} },
];

export async function testLimitTime(t: any) {
    for (const tc of limitTimeCases) {
        await t.run(tc.name, async () => {
            const parsed = await parse(tc.args);
            assertLimits(parsed.limits, tc.expect);
        });
    }
}

// ── --limit-memory ──────────────────────────────────────────────────

const limitMemoryCases: LimitTestCase[] = [
    { name: "--limit-memory=256 parses as memoryMB", args: ["--limit-memory=256", "app.js"], expect: { memoryMB: 256 } },
    { name: "--limit-memory=512", args: ["--limit-memory=512", "app.js"], expect: { memoryMB: 512 } },
];

export async function testLimitMemory(t: any) {
    for (const tc of limitMemoryCases) {
        await t.run(tc.name, async () => {
            const parsed = await parse(tc.args);
            assertLimits(parsed.limits, tc.expect);
        });
    }
}

// ── Combined flags ──────────────────────────────────────────────────

export async function testLimitCombined(t: any) {
    await t.run("--limit-time and --limit-memory together", async () => {
        const parsed = await parse(["--limit-time=5000", "--limit-memory=256", "app.js"]);
        const got = parsed.limits;
        if (got.timeoutMillis !== 5000) throw new Error(`timeoutMillis: expected 5000, got ${got.timeoutMillis}`);
        if (got.memoryMB !== 256) throw new Error(`memoryMB: expected 256, got ${got.memoryMB}`);
    });
}

// ── --dir ───────────────────────────────────────────────────────────

export async function testDirFlag(t: any) {
    await t.run("--dir=/some/path sets flags.dir", async () => {
        const parsed = await parse(["--dir=/some/path", "app.js"]);
        if (parsed.flags.dir !== "/some/path") {
            throw new Error(`Expected flags.dir === "/some/path", got "${parsed.flags.dir}"`);
        }
    });

    await t.run("--dir=/other/path", async () => {
        const parsed = await parse(["--dir=/other/path", "app.js"]);
        if (parsed.flags.dir !== "/other/path") {
            throw new Error(`Expected flags.dir === "/other/path", got "${parsed.flags.dir}"`);
        }
    });
}

// ── Strict Positional Preservation ──────────────────────────────────

interface PreservationTestCase {
    name: string;
    args: string[];
    expectTarget: string;
    expectGuestArgs: string[];
}

const preservationCases: PreservationTestCase[] = [
    {
        name: "Preserves trailing flags and values exactly as provided",
        args: ["--limit-time=1000", "openssl", "s_server", "-cert", "test-cert.pem", "--foo=bar"],
        expectTarget: "openssl",
        expectGuestArgs: ["s_server", "-cert", "test-cert.pem", "--foo=bar"],
    },
    {
        name: "-- before target consumes first positional as target",
        args: ["--limit-memory=512", "--", "openssl", "-cert", "test-cert.pem"],
        expectTarget: "openssl",
        expectGuestArgs: ["-cert", "test-cert.pem"],
    },
];

export async function testGuestArgsPreservation(t: any) {
    for (const tc of preservationCases) {
        await t.run(tc.name, async () => {
            const parsed = await parse(tc.args);
            
            if (parsed.target !== tc.expectTarget) {
                throw new Error(`Expected target "${tc.expectTarget}", got "${parsed.target}"`);
            }
            
            if (parsed.guestArgs.length !== tc.expectGuestArgs.length) {
                throw new Error(`Expected ${tc.expectGuestArgs.length} guestArgs, got ${parsed.guestArgs.length}: [${parsed.guestArgs.join(", ")}]`);
            }
            
            for (let i = 0; i < tc.expectGuestArgs.length; i++) {
                if (parsed.guestArgs[i] !== tc.expectGuestArgs[i]) {
                    throw new Error(`Expected guestArgs[${i}] === "${tc.expectGuestArgs[i]}", got "${parsed.guestArgs[i]}"`);
                }
            }
        });
    }
}


// ── -h flag ─────────────────────────────────────────────────────────

export async function testShortHelpFlag(t: any) {
    await t.run("-h triggers help (same as --help)", async () => {
        let helpPrinted = false;
        const deps = {
            ...stubDeps,
            console: { log() { helpPrinted = true; }, error() {} },
        };
        try {
            await cli(["-h"], {}, deps as any);
        } catch (e: any) {
            if (e.message !== "exit") throw e;
        }
        if (!helpPrinted) {
            throw new Error("Expected -h to trigger help output");
        }
    });
}
