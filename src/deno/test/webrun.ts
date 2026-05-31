// test_harness.ts — Standalone, web-standards-compliant test harness.
// All I/O is delegated to a Reporter — the harness only produces structured results.

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

/** Structured test result — the contract between harness and reporter. */
export interface Result {
    name: string;
    path: string[];
    status: "ok" | "failed" | "skipped" | "filtered";
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

export interface SuiteStats {
    topPassed: number;
    topFailed: number;
    topSkipped: number;
    stepPassed: number;
    stepFailed: number;
    durationMs: number;
}

// =========================================================
// REPORTER
// =========================================================

/** Reporter interface — all formatting is the reporter's concern. */
export interface Reporter {
    /** Called once before tests run. */
    suiteStart(source: string, count: number): void;
    /** Called after each nested step completes (streaming). */
    stepResult(result: Result, depth: number): void;
    /** Called after each top-level test completes. */
    testResult(result: Result, stepCounts: { failed: number }): void;
    /** Called once after all tests with errors and summary. */
    suiteEnd(failures: Result[], stats: SuiteStats, source: string): void;
}

/** Create a Deno-compatible text reporter. */
export function createReporter(
    print: (line: string) => void,
    options?: { color?: boolean },
): Reporter {
    const color = options?.color ?? true;
    const c = color
        ? { green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", gray: "\x1b[90m", reset: "\x1b[0m" }
        : { green: "", red: "", yellow: "", gray: "", reset: "" };

    function statusLabel(s: Result["status"]): string {
        if (s === "ok")     return `${c.green}ok${c.reset}`;
        if (s === "failed") return `${c.red}FAILED${c.reset}`;
        return `${c.yellow}ignored${c.reset}`;
    }

    function formatError(err: unknown): string {
        if (err === null)      return "error: null";
        if (err === undefined) return "error: undefined";
        if (typeof err !== "object" && typeof err !== "function") return `error: ${String(err)}`;
        if (err instanceof Error) {
            if (err.stack) return err.stack.replace(/^[A-Za-z]*Error:/, "error:");
            return `error: ${err.message}`;
        }
        try { return `error: ${JSON.stringify(err)}`; } catch { return `error: ${String(err)}`; }
    }

    function printLogs(logs: string[], pad: string): void {
        if (logs.length > 0) {
            print(`${pad}------- output -------`);
            for (const l of logs) print(`${pad}${l}`);
            print(`${pad}----- output end -----`);
        }
    }

    return {
        suiteStart(source, count) {
            print(`running ${count} tests from ${source}`);
        },

        stepResult(result, depth) {
            if (result.status === "filtered") return;
            const pad = "  ".repeat(depth + 1);
            printLogs(result.logs, pad);
            print(`${pad}${result.name} ... ${statusLabel(result.status)} ${c.gray}(${result.durationMs}ms)${c.reset}`);
        },

        testResult(result, stepCounts) {
            if (result.status === "filtered") return;
            printLogs(result.logs, "");
            const t = `${c.gray}(${result.durationMs}ms)${c.reset}`;
            if (result.status === "failed") {
                const suffix = stepCounts.failed > 0 ? ` (due to ${stepCounts.failed} failed steps)` : "";
                print(`${result.name} ... ${c.red}FAILED${c.reset}${suffix} ${t}`);
            } else if (result.status === "skipped") {
                print(`${result.name} ... ${c.yellow}ignored${c.reset} ${t}`);
            } else {
                print(`${result.name} ... ${c.green}ok${c.reset} ${t}`);
            }
        },

        suiteEnd(failures, stats, source) {
            if (failures.length > 0) {
                print(`\n ${c.red}ERRORS${c.reset}\n`);
                for (const f of failures) {
                    print(`${f.path.join(" > ")} => ${source}`);
                    print(formatError(f.error));
                    print("");
                }
                print(` ${c.red}FAILURES${c.reset}\n`);
                for (const f of failures) print(f.path.join(" > "));
            }

            const { topPassed, topFailed, topSkipped, stepPassed, stepFailed, durationMs } = stats;
            const passStr = stepPassed > 0 ? `${topPassed} passed (${stepPassed} steps)` : `${topPassed} passed`;
            const failStr = stepFailed > 0 ? `${topFailed} failed (${stepFailed} steps)` : `${topFailed} failed`;
            const ignoredStr = topSkipped > 0 ? ` | ${topSkipped} ignored` : "";
            const prefix = topFailed > 0 ? `${c.red}FAILED${c.reset}` : `${c.green}ok${c.reset}`;
            print(`\n${prefix} | ${passStr} | ${failStr}${ignoredStr} ${c.gray}(${durationMs}ms)${c.reset}`);
        },
    };
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
// INTERNAL: FILTER
// =========================================================

/** Parsed filter — a path of one or more segments applied uniformly at each depth. */
type Filter =
    | { kind: "none" }
    | { kind: "path"; segments: string[] };

function parseFilter(filterStr: string | undefined): Filter {
    if (!filterStr) return { kind: "none" };
    return { kind: "path", segments: filterStr.split(" > ") };
}

/** Does a name match the filter segment at the given depth? */
function matchesSegment(filter: Filter, name: string, depth: number): boolean {
    if (filter.kind === "none") return true;
    if (depth >= filter.segments.length) return true;
    return name.includes(filter.segments[depth]);
}

/** Should a sub-step at the given depth be included? */
function matchesStep(filter: Filter, subName: string, depth: number, passThrough: boolean): boolean {
    if (passThrough) return true;
    // Sub-steps use depth+1 because depth 0 is the first sub-step level,
    // and segment[0] was consumed by the top-level match.
    return matchesSegment(filter, subName, depth + 1);
}

/** Once all filter segments have been consumed, children pass through. */
function isPassThroughAfter(filter: Filter, depth: number, passThrough: boolean): boolean {
    if (passThrough) return true;
    if (filter.kind === "none") return true;
    const segIdx = depth + 1;
    return segIdx >= filter.segments.length - 1;
}

// =========================================================
// INTERNAL: CONTEXT FACTORY
// =========================================================

function createCtx(
    name: string,
    path: string[],
    filter: Filter,
    passThrough: boolean,
    childResults: Result[],
    logSink: (line: string) => void,
    reporter: Reporter | undefined,
    depth?: number,
): TestContext {
    return {
        name,

        async run(subName: string, subFn: (t: TestContext) => Promise<void>): Promise<void> {
            const d = depth ?? 0;
            if (!matchesStep(filter, subName, d, passThrough)) return;

            const subPath = [...path, subName];
            const subLogs: string[] = [];
            const subChildren: Result[] = [];
            const childPassThrough = isPassThroughAfter(filter, d, passThrough);
            const subCtx = createCtx(subName, subPath, filter, childPassThrough, subChildren, (l) => subLogs.push(l), reporter, d + 1);

            const start = performance.now();
            let status: Result["status"] = "ok";
            let error: unknown;

            try {
                await subFn(subCtx);
                if (subChildren.some((ch) => ch.status === "failed")) status = "failed";
            } catch (err) {
                if (isSkip(err)) { status = "skipped"; } else { status = "failed"; error = err; }
            }

            // If the filter has unconsumed segments and no children matched,
            // this step matched an intermediate segment but nothing deeper — filtered.
            if (status === "ok" && !childPassThrough && subChildren.length === 0) {
                status = "filtered";
            }

            const result: Result = {
                name: subName, path: subPath, status,
                durationMs: Math.round(performance.now() - start),
                error, children: subChildren, logs: subLogs,
            };
            childResults.push(result);

            if (reporter) reporter.stepResult(result, d);
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
        else if (r.status === "skipped") skipped++;
        // "filtered" — not counted
        const sub = count(r.children);
        passed += sub.passed; failed += sub.failed; skipped += sub.skipped;
    }
    return { passed, failed, skipped };
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
 * Runs a test suite, delegating all output to the reporter.
 *
 * Filtering is uniform at every depth:
 * - Single segment: matches top-level test names. Children pass through.
 * - Multi-segment (`A > B > C`): segment N matches at depth N.
 *
 * @param tests     Ordered list of { name, fn } descriptors.
 * @param ctx       Forwarded as the second argument to each test fn.
 * @param source    Label shown in the header line.
 * @param reporter  Output reporter — receives structured results.
 * @param filterStr Optional filter — substring or path (`A > B > C`).
 */
export async function runTestSuite(
    tests: Array<{ name: string; fn: (t: TestContext, ctx: any) => Promise<void> }>,
    ctx: any,
    source: string,
    reporter: Reporter,
    filterStr?: string,
): Promise<HarnessSummary> {
    const filter = parseFilter(filterStr);

    // Segment[0] filters top-level test names. No fallthrough.
    const active = filter.kind === "none"
        ? tests
        : tests.filter(({ name }) => matchesSegment(filter, name, 0));

    reporter.suiteStart(source, active.length);

    // ── Rejection tracking ──
    let rejectCurrentTest: ((reason: any) => void) | null = null;
    const onRejection = (e: PromiseRejectionEvent) => {
        if (rejectCurrentTest) {
            e.preventDefault();
            const reject = rejectCurrentTest;
            rejectCurrentTest = null;
            const reason = e.reason;
            const message = reason instanceof Error
                ? `Unhandled promise rejection: ${reason.stack || reason.message}`
                : `Unhandled promise rejection: ${String(reason)}`;
            reject(new Error(message));
        }
    };
    globalThis.addEventListener('unhandledrejection', onRejection);

    const suiteStart = performance.now();
    let topPassed = 0, topFailed = 0, topSkipped = 0;
    let stepPassed = 0, stepFailed = 0;
    const allFailures: Result[] = [];

    for (const { name, fn } of active) {
        const topLogs: string[] = [];
        const topChildren: Result[] = [];
        // passThrough when the filter is fully consumed at the top level:
        // - no filter → everything runs
        // - single segment → top-level matched, children run unconditionally
        // - multi-segment → remaining segments still filter sub-steps
        const passThrough = filter.kind === "none" || filter.segments.length <= 1;
        const topCtx = createCtx(name, [name], filter, passThrough, topChildren, (l) => topLogs.push(l), reporter, 0);

        const start = performance.now();
        let status: Result["status"] = "ok";
        let error: unknown;

        try {
            const tripwire = new Promise<never>((_, reject) => { rejectCurrentTest = reject; });
            await Promise.race([fn(topCtx, ctx), tripwire]);
            if (topChildren.some((s) => s.status === "failed")) status = "failed";
        } catch (err) {
            if (isSkip(err)) { status = "skipped"; } else { status = "failed"; error = err; }
        }
        rejectCurrentTest = null;

        // If the filter has unconsumed segments and no children matched,
        // this test matched segment[0] but nothing deeper — filtered.
        if (status === "ok" && !passThrough && topChildren.length === 0) {
            status = "filtered";
        }

        const durationMs = Math.round(performance.now() - start);
        const result: Result = { name, path: [name], status, durationMs, error, children: topChildren, logs: topLogs };

        if (status === "ok") topPassed++;
        else if (status === "failed") topFailed++;
        else if (status === "skipped") topSkipped++;
        // "filtered" — not counted

        const sc = count(topChildren);
        stepPassed += sc.passed;
        stepFailed += sc.failed;
        for (const f of failures([result])) allFailures.push(f);

        reporter.testResult(result, { failed: sc.failed });
    }

    const totalMs = Math.round(performance.now() - suiteStart);
    reporter.suiteEnd(allFailures, {
        topPassed, topFailed, topSkipped,
        stepPassed, stepFailed, durationMs: totalMs,
    }, source);

    globalThis.removeEventListener('unhandledrejection', onRejection as EventListener);

    return { passed: topPassed, failed: topFailed, skipped: topSkipped };
}
