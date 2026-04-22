// test_harness.ts — Standalone, web-standards-compliant test harness.
// Replicates Deno.test output format. No Deno globals — all I/O via injected `print`.

// =========================================================
// TYPES
// =========================================================

export interface TestContext {
    readonly name: string;
    run(name: string, fn: (t: TestContext) => Promise<void>): Promise<void>;
    assert(condition: any, message?: string): void;
    fail(message?: string): void;
    skip(message?: string): never;
    log(...args: unknown[]): void;
}

// Single recursive type — covers both top-level tests and nested steps.
interface Result {
    name: string;
    path: string[];
    status: "ok" | "failed" | "skipped";
    durationMs: number;
    error?: unknown;
    children: Result[];
    logs: string[];
}

export interface HarnessSummary {
    passed: number;
    failed: number;
    skipped: number;
}

// =========================================================
// INTERNAL: SKIP SIGNAL
// =========================================================

class HarnessSkipError {
    readonly name = "HarnessSkipError";
    constructor(readonly message: string) {}
}

function isSkip(err: unknown): err is HarnessSkipError {
    return err instanceof HarnessSkipError;
}

// =========================================================
// INTERNAL: CONTEXT FACTORY
// =========================================================

function createCtx(
    name: string,
    path: string[],
    filterStr: string | undefined,
    /** When true, all sub-steps run unconditionally. */
    passThrough: boolean,
    childResults: Result[],
    logSink: (line: string) => void,
    /** Immediate output sink for real-time streaming. */
    print?: (line: string) => void,
    /** Nesting depth for indentation. */
    depth?: number,
): TestContext {
    return {
        name,

        async run(subName: string, subFn: (t: TestContext) => Promise<void>): Promise<void> {
            if (filterStr && !passThrough && !subName.includes(filterStr)) return;

            const subPath = [...path, subName];
            const subLogs: string[] = [];
            const subChildren: Result[] = [];
            const subCtx = createCtx(subName, subPath, filterStr, true, subChildren, (l) => subLogs.push(l), print, (depth ?? 0) + 1);

            const start = performance.now();
            let status: Result["status"] = "ok";
            let error: unknown;

            try {
                await subFn(subCtx);
                if (subChildren.some((c) => c.status === "failed")) status = "failed";
            } catch (err) {
                if (isSkip(err)) { status = "skipped"; } else { status = "failed"; error = err; }
            }

            const result: Result = {
                name: subName, path: subPath, status,
                durationMs: Math.round(performance.now() - start),
                error, children: subChildren, logs: subLogs,
            };
            childResults.push(result);

            // Stream immediately if a print sink is available.
            if (print) {
                const d = depth ?? 0;
                const pad = "  ".repeat(d + 1);
                if (result.logs.length > 0) {
                    print(`${pad}------- output -------`);
                    for (const l of result.logs) print(`${pad}${l}`);
                    print(`${pad}----- output end -----`);
                }
                print(`${pad}${result.name} ... ${statusLabel(result.status)} ${C.gray}(${result.durationMs}ms)${C.reset}`);
                // Sub-children were already streamed by their own createCtx calls.
            }
        },

        assert(condition: any, message?: string): void {
            if (!condition) throw new Error(message ?? "Assertion failed");
        },

        fail(message?: string): void {
            throw new Error(message ?? "Test failed explicitly");
        },

        skip(message?: string): never {
            throw new HarnessSkipError(message ?? "Skipped");
        },

        log(...args: unknown[]): void {
            logSink(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
        },
    };
}

// =========================================================
// INTERNAL: COUNTING
// =========================================================

function count(results: Result[]): { passed: number; failed: number; skipped: number } {
    let passed = 0, failed = 0, skipped = 0;
    for (const r of results) {
        if (r.status === "ok") passed++;
        else if (r.status === "failed") failed++;
        else skipped++;
        const sub = count(r.children);
        passed += sub.passed; failed += sub.failed; skipped += sub.skipped;
    }
    return { passed, failed, skipped };
}

// =========================================================
// INTERNAL: FORMATTING
// =========================================================

const C = {
    green:  "\x1b[32m",
    red:    "\x1b[31m",
    yellow: "\x1b[33m",
    gray:   "\x1b[90m",
    reset:  "\x1b[0m",
};

function statusLabel(s: Result["status"]): string {
    if (s === "ok")     return `${C.green}ok${C.reset}`;
    if (s === "failed") return `${C.red}FAILED${C.reset}`;
    return `${C.yellow}ignored${C.reset}`;
}

function formatError(err: unknown): string {
    if (err === null)      return "error: null";
    if (err === undefined) return "error: undefined";
    if (typeof err !== "object" && typeof err !== "function") return `error: ${String(err)}`;
    if (err instanceof Error) {
        // V8 stack: "TypeError: msg\n    at ..." — normalize prefix to lowercase "error:".
        if (err.stack) return err.stack.replace(/^[A-Za-z]*Error:/, "error:");
        return `error: ${err.message}`;
    }
    try { return `error: ${JSON.stringify(err)}`; } catch { return `error: ${String(err)}`; }
}

// Render a result tree directly to `print`, no intermediate buffer.
function render(result: Result, depth: number, print: (l: string) => void): void {
    const pad = "  ".repeat(depth);
    if (result.logs.length > 0) {
        print(`${pad}------- output -------`);
        for (const l of result.logs) print(`${pad}${l}`);
        print(`${pad}----- output end -----`);
    }
    print(`${pad}${result.name} ... ${statusLabel(result.status)} ${C.gray}(${result.durationMs}ms)${C.reset}`);
    for (const child of result.children) render(child, depth + 1, print);
}

// Yield every result in the tree that has an error.
function* failures(results: Result[]): Generator<Result> {
    for (const r of results) {
        if (r.error !== undefined) yield r;
        yield* failures(r.children);
    }
}

// =========================================================
// PUBLIC API
// =========================================================

/**
 * Runs a test suite, printing Deno-compatible output to `print`.
 *
 * @param tests     Ordered list of { name, fn } descriptors.
 * @param ctx       Forwarded as the second argument to each test fn.
 * @param source    Label shown in the header line.
 * @param print     Unbuffered output sink — called once per line.
 * @param filterStr   Optional substring filter applied to test/step names.
 */
export async function runTestSuite(
    tests: Array<{ name: string; fn: (t: TestContext, ctx: any) => Promise<void> }>,
    ctx: any,
    source: string,
    print: (line: string) => void,
    filterStr?: string,
): Promise<HarnessSummary> {
    const hasTopMatch = filterStr ? tests.some(({ name }) => name.includes(filterStr)) : false;
    const active = hasTopMatch && filterStr
        ? tests.filter(({ name }) => name.includes(filterStr))
        : tests;

    print(`running ${active.length} tests from ${source}`);

    const suiteStart = performance.now();
    let topPassed = 0, topFailed = 0, topSkipped = 0;
    let stepPassed = 0, stepFailed = 0;
    const allFailures: Result[] = [];

    for (const { name, fn } of active) {
        const topLogs: string[] = [];
        const topChildren: Result[] = [];
        // passThrough=true when filter selects this test by name, or no filter at all.
        const passThrough = !filterStr || hasTopMatch;
        const topCtx = createCtx(name, [name], filterStr, passThrough, topChildren, (l) => topLogs.push(l), print, 0);

        const start = performance.now();
        let status: Result["status"] = "ok";
        let error: unknown;

        try {
            await fn(topCtx, ctx);
            if (topChildren.some((s) => s.status === "failed")) status = "failed";
        } catch (err) {
            if (isSkip(err)) { status = "skipped"; } else { status = "failed"; error = err; }
        }

        const durationMs = Math.round(performance.now() - start);
        const result: Result = { name, path: [name], status, durationMs, error, children: topChildren, logs: topLogs };

        // Accumulate totals inline — single pass, no second iteration over results.
        if (status === "ok") topPassed++; else if (status === "failed") topFailed++; else topSkipped++;
        const sc = count(topChildren);
        stepPassed += sc.passed;
        stepFailed += sc.failed;
        for (const f of failures([result])) allFailures.push(f);

        // ── Per-test output ──
        // Step results were already streamed inline by createCtx.
        // Print the top-level test's own logs and summary line.
        if (topLogs.length > 0) {
            print(`------- output -------`);
            for (const l of topLogs) print(l);
            print(`----- output end -----`);
        }

        const t = `${C.gray}(${durationMs}ms)${C.reset}`;
        if (status === "failed") {
            const suffix = sc.failed > 0 ? ` (due to ${sc.failed} failed steps)` : "";
            print(`${name} ... ${C.red}FAILED${C.reset}${suffix} ${t}`);
        } else if (status === "skipped") {
            print(`${name} ... ${C.yellow}ignored${C.reset} ${t}`);
        } else {
            print(`${name} ... ${C.green}ok${C.reset} ${t}`);
        }
    }

    // ── ERRORS section ──
    if (allFailures.length > 0) {
        print(`\n ${C.red}ERRORS${C.reset}\n`);
        for (const f of allFailures) {
            print(`${f.path.join(" > ")} => ${source}`);
            print(formatError(f.error));
            print("");
        }
        print(` ${C.red}FAILURES${C.reset}\n`);
        for (const f of allFailures) print(f.path.join(" > "));
    }

    // ── Summary ──
    const totalMs = Math.round(performance.now() - suiteStart);
    const passStr = stepPassed > 0 ? `${topPassed} passed (${stepPassed} steps)` : `${topPassed} passed`;
    const failStr = stepFailed > 0 ? `${topFailed} failed (${stepFailed} steps)` : `${topFailed} failed`;
    const ignoredStr = topSkipped > 0 ? ` | ${topSkipped} ignored` : "";
    const prefix = topFailed > 0 ? `${C.red}FAILED${C.reset}` : `${C.green}ok${C.reset}`;
    print(`\n${prefix} | ${passStr} | ${failStr}${ignoredStr} ${C.gray}(${totalMs}ms)${C.reset}`);

    return { passed: topPassed, failed: topFailed, skipped: topSkipped };
}
