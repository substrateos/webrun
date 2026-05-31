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
