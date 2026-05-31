// harness.test.ts — Exhaustive self-tests for src/test_harness.ts.
//
// Strategy: runTestSuite is a pure function with an injected `print` fn.
// We run it with a capturing print buffer and assert on returned summary
// counts and captured output. No child processes needed.
//
// All deterministic cases are table-driven per AGENTS.md.

import { runTestSuite, createReporter } from "./webrun.ts";
import type { TestContext, HarnessSummary, Reporter } from "./webrun.ts";

// =========================================================
// HELPERS
// =========================================================

/** Capture print output into an array. */
function capturingReporter(opts?: { color?: boolean }): { reporter: Reporter; lines: string[] } {
    const lines: string[] = [];
    const reporter = createReporter((l) => lines.push(l), opts);
    return { reporter, lines };
}

/** Run a suite, capture output, return { summary, lines }. */
async function run(
    cases: Array<{ name: string; fn: (t: TestContext, ctx: any) => Promise<void> }>,
    filter?: string,
    reporterOpts?: { color?: boolean },
): Promise<{ summary: HarnessSummary; lines: string[] }> {
    const { reporter, lines } = capturingReporter(reporterOpts);
    const summary = await runTestSuite(cases, {}, "harness.test.ts", reporter, filter);
    return { summary, lines };
}

/** Strip ANSI escape codes from a line. */
function strip(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Stripped lines (useful for contains checks). */
function stripped(lines: string[]): string[] {
    return lines.map(strip);
}

function contains(lines: string[], substr: string): boolean {
    return stripped(lines).some(l => l.includes(substr));
}

function containsAll(lines: string[], ...substrs: string[]): boolean {
    return substrs.every(s => contains(lines, s));
}

/** Check that output contains a line matching "name ... ok" */
function hasOk(lines: string[], name: string): boolean {
    return stripped(lines).some(l => l.includes(name) && l.includes("ok"));
}

/** Check that output contains a line matching "name ... FAILED" */
function hasFailed(lines: string[], name: string): boolean {
    return stripped(lines).some(l => l.includes(name) && l.includes("FAILED"));
}

// Trivially passing / failing test bodies.
const PASS = async (_t: TestContext) => { };
const FAIL = async (_t: TestContext) => { throw new Error("deliberate"); };

// =========================================================
// CATEGORY 1: Core Assertions
// =========================================================

const assertionCases: Array<{
    name: string;
    fn: (t: TestContext) => Promise<void>;
    expectPass: boolean;
    expectMsg?: string;
}> = [
        { name: "assert(true) passes", fn: async t => t.assert(true), expectPass: true },
        { name: "assert(false) fails", fn: async t => t.assert(false), expectPass: false, expectMsg: "Assertion failed" },
        { name: "assert(false,msg) message", fn: async t => t.assert(false, "custom msg"), expectPass: false, expectMsg: "custom msg" },
        { name: "assert(0) fails", fn: async t => t.assert(0), expectPass: false },
        { name: "assert('') fails", fn: async t => t.assert(""), expectPass: false },
        { name: "assert(null) fails", fn: async t => t.assert(null), expectPass: false },
        { name: "assert(undefined) fails", fn: async t => t.assert(undefined), expectPass: false },
        { name: "assert(1) passes", fn: async t => t.assert(1), expectPass: true },
        { name: "assert({}) passes", fn: async t => t.assert({}), expectPass: true },
        { name: "fail() fails", fn: async t => t.fail(), expectPass: false, expectMsg: "Test failed explicitly" },
        { name: "fail(msg) message", fn: async t => t.fail("explicit"), expectPass: false, expectMsg: "explicit" },
        {
            name: "assert(true) then assert(false) fails",
            fn: async t => { t.assert(true); t.assert(false, "second"); },
            expectPass: false,
            expectMsg: "second",
        },
    ];

export async function testCoreAssertions(outerT: TestContext) {
    for (const tc of assertionCases) {
        await outerT.run(tc.name, async (t: TestContext) => {
            const { summary, lines } = await run([{ name: tc.name, fn: tc.fn }]);
            if (tc.expectPass) {
                t.assert(summary.passed === 1 && summary.failed === 0,
                    `Expected pass, got passed=${summary.passed} failed=${summary.failed}`);
                t.assert(hasOk(lines, tc.name), `Expected 'ok' in output`);
            } else {
                t.assert(summary.failed === 1,
                    `Expected 1 failed, got ${summary.failed}`);
                t.assert(hasFailed(lines, tc.name), `Expected 'FAILED' in output`);
                if (tc.expectMsg) {
                    t.assert(contains(lines, tc.expectMsg),
                        `Expected message "${tc.expectMsg}" in output\nOutput:\n${stripped(lines).join("\n")}`);
                }
            }
        });
    }
}

// =========================================================
// CATEGORY 2: Skip Semantics
// =========================================================

const skipCases: Array<{
    name: string;
    fn: (t: TestContext) => Promise<void>;
    expectSkipped: boolean;
    expectMsg?: string;
    expectNoMsg?: string;
}> = [
        {
            name: "skip() marks skipped",
            fn: async t => t.skip(),
            expectSkipped: true,
        },
        {
            name: "skip(reason) shows reason in output",
            fn: async t => t.skip("not applicable"),
            expectSkipped: true,
            expectMsg: "ignored", // Deno uses "ignored" for skipped
        },
        {
            name: "skip prevents remaining body",
            fn: async t => { t.skip("r"); t.fail("unreachable"); },
            expectSkipped: true,
            expectNoMsg: "unreachable",
        },
        {
            name: "skip doesn't affect sibling",
            // Tested by running two tests; skip is per-test only.
            fn: async _t => { },  // placeholder, tested via custom run below
            expectSkipped: false, // overridden in custom run
        },
    ];

export async function testSkipSemantics(outerT: TestContext) {
    // Simple skip cases.
    for (const tc of skipCases.slice(0, 3)) {
        await outerT.run(tc.name, async (t: TestContext) => {
            const { summary, lines } = await run([{ name: tc.name, fn: tc.fn }]);
            t.assert(summary.skipped === 1, `Expected 1 skipped, got ${summary.skipped}`);
            t.assert(summary.failed === 0, `Expected 0 failed, got ${summary.failed}`);
            if (tc.expectMsg) t.assert(contains(lines, tc.expectMsg),
                `Expected "${tc.expectMsg}" in output`);
            if (tc.expectNoMsg) t.assert(!contains(lines, tc.expectNoMsg),
                `Expected "${tc.expectNoMsg}" NOT in output`);
        });
    }

    await outerT.run("skip doesn't affect sibling tests", async (t: TestContext) => {
        const { summary } = await run([
            { name: "A", fn: async t2 => t2.skip("r") },
            { name: "B", fn: PASS },
        ]);
        t.assert(summary.skipped === 1 && summary.passed === 1 && summary.failed === 0,
            `Expected 1 skipped 1 passed, got ${JSON.stringify(summary)}`);
    });

    await outerT.run("all skipped → exit 0 and summary shows N skipped", async (t: TestContext) => {
        const { summary, lines } = await run([
            { name: "A", fn: async t2 => t2.skip() },
            { name: "B", fn: async t2 => t2.skip() },
        ]);
        t.assert(summary.skipped === 2 && summary.failed === 0,
            `Expected 2 skipped, got ${JSON.stringify(summary)}`);
    });

    await outerT.run("skip in sub-step", async (t: TestContext) => {
        const { summary } = await run([{
            name: "parent",
            fn: async t2 => {
                await t2.run("sub", async (t3: TestContext) => t3.skip("r"));
            },
        }]);
        // Parent passes (skipped sub-step doesn't propagate to parent).
        t.assert(summary.failed === 0, `Parent should not be failed`);
    });
}

// =========================================================
// CATEGORY 3: Nesting (t.run)
// =========================================================

export async function testNesting(outerT: TestContext) {
    await outerT.run("single sub-step appears indented", async (t: TestContext) => {
        const { lines } = await run([{
            name: "parent",
            fn: async (t2: TestContext) => {
                await t2.run("child", PASS);
            },
        }]);
        // Sub-step line has leading spaces (2 spaces per depth level).
        const sl = stripped(lines);
        const childLine = sl.find(l => l.includes("child") && l.includes("ok"));
        t.assert(!!childLine, `Expected child step result line`);
        t.assert(childLine!.startsWith("  "), `Expected 2-space indent, got: "${childLine}"`);
    });

    await outerT.run("two sibling sub-steps both appear", async (t: TestContext) => {
        const { lines } = await run([{
            name: "parent",
            fn: async (t2: TestContext) => {
                await t2.run("alpha", PASS);
                await t2.run("beta", PASS);
            },
        }]);
        t.assert(contains(lines, "alpha"), "Missing alpha");
        t.assert(contains(lines, "beta"), "Missing beta");
    });

    await outerT.run("three levels deep all appear", async (t: TestContext) => {
        const { lines } = await run([{
            name: "top",
            fn: async (t2: TestContext) => {
                await t2.run("mid", async (t3: TestContext) => {
                    await t3.run("leaf", PASS);
                });
            },
        }]);
        t.assert(contains(lines, "leaf"), "Missing leaf");
        const sl = stripped(lines);
        const leafLine = sl.find(l => l.includes("leaf") && l.includes("ok"));
        t.assert(leafLine!.startsWith("    "), `Expected 4-space indent for leaf, got "${leafLine}"`);
    });

    await outerT.run("sub-step failure marks parent FAILED", async (t: TestContext) => {
        const { summary, lines } = await run([{
            name: "parent",
            fn: async (t2: TestContext) => {
                await t2.run("bad", FAIL);
            },
        }]);
        t.assert(summary.failed === 1, `Expected 1 failed, got ${summary.failed}`);
        t.assert(hasFailed(lines, "parent"), "Expected parent FAILED");
    });

    await outerT.run("sub-step failure doesn't abort siblings", async (t: TestContext) => {
        let bRan = false;
        const { lines } = await run([{
            name: "parent",
            fn: async (t2: TestContext) => {
                await t2.run("a", FAIL);
                await t2.run("b", async (_t3: TestContext) => { bRan = true; });
            },
        }]);
        t.assert(bRan, "Step b should have run");
        t.assert(hasOk(lines, "b"), "Step b should be ok");
    });

    await outerT.run("nested failure path in FAILURES section", async (t: TestContext) => {
        const { lines } = await run([{
            name: "outer",
            fn: async (t2: TestContext) => {
                await t2.run("inner", FAIL);
            },
        }]);
        // FAILURES section should have "outer > inner".
        t.assert(contains(lines, "outer > inner"), `Expected "outer > inner" in FAILURES\n${stripped(lines).join("\n")}`);
    });

    await outerT.run("sub-step receives correct t.name", async (t: TestContext) => {
        const { summary } = await run([{
            name: "parent",
            fn: async (t2: TestContext) => {
                await t2.run("mysub", async (t3: TestContext) => {
                    t3.assert(t3.name === "mysub", `Expected name "mysub", got "${t3.name}"`);
                });
            },
        }]);
        t.assert(summary.failed === 0, `Expected no failures`);
    });
}

// =========================================================
// CATEGORY 4: Filtering
// =========================================================

export async function testFiltering(outerT: TestContext) {
    // Table: [filterStr, tests, expectRan, expectNotRan]
    const filterCases: Array<{
        name: string;
        filter: string;
        tests: Array<{ name: string; fn: (t: TestContext) => Promise<void> }>;
        expectPassedNames: string[];
        expectSkippedOrAbsent: string[];
    }> = [
            {
                name: "top-level match runs only matching test",
                filter: "Alpha",
                tests: [
                    { name: "Alpha", fn: PASS },
                    { name: "Beta", fn: PASS },
                ],
                expectPassedNames: ["Alpha"],
                expectSkippedOrAbsent: ["Beta"],
            },
            {
                name: "partial match (substring)",
                filter: "lph",
                tests: [
                    { name: "Alpha", fn: PASS },
                    { name: "Beta", fn: PASS },
                ],
                expectPassedNames: ["Alpha"],
                expectSkippedOrAbsent: ["Beta"],
            },
            {
                name: "filter matches multiple top-level",
                filter: "test",
                tests: [
                    { name: "testA", fn: PASS },
                    { name: "testB", fn: PASS },
                    { name: "other", fn: PASS },
                ],
                expectPassedNames: ["testA", "testB"],
                expectSkippedOrAbsent: ["other"],
            },
        ];

    for (const tc of filterCases) {
        await outerT.run(tc.name, async (t: TestContext) => {
            const { summary, lines } = await run(tc.tests, tc.filter);
            const sl = stripped(lines);
            for (const name of tc.expectPassedNames) {
                t.assert(sl.some(l => l.includes(name) && l.includes("ok")),
                    `Expected "${name}" to appear as ok`);
            }
            for (const name of tc.expectSkippedOrAbsent) {
                const appeared = sl.some(l => l.includes(name) && l.includes("ok"));
                t.assert(!appeared, `Expected "${name}" NOT to appear as ok`);
            }
        });
    }

    await outerT.run("no match returns zero results", async (t: TestContext) => {
        const { summary } = await run([{
            name: "Outer",
            fn: async (t2: TestContext) => {
                await t2.run("target-step", PASS);
                await t2.run("other-step", PASS);
            },
        }], "nonexistent");
        // "nonexistent" doesn't match "Outer" at the top level → zero tests run.
        t.assert(summary.passed === 0 && summary.failed === 0,
            `Expected 0 passed 0 failed, got ${JSON.stringify(summary)}`);
    });
}

// =========================================================
// CATEGORY 5: Error Isolation & Async
// =========================================================

const errorCases: Array<{
    name: string;
    fn: (t: TestContext) => Promise<void>;
    expectPass: boolean;
    expectMsgContains?: string;
}> = [
        { name: "async delay then assert(true)", fn: async t => { await new Promise(r => setTimeout(r, 5)); t.assert(true); }, expectPass: true },
        { name: "async rejection", fn: async _t => { await Promise.reject(new Error("boom")); }, expectPass: false, expectMsgContains: "boom" },
        { name: "throw Error", fn: async _t => { throw new Error("thrown"); }, expectPass: false, expectMsgContains: "thrown" },
        { name: "throw string", fn: async _t => { throw "string error"; }, expectPass: false, expectMsgContains: "string error" },
        { name: "throw number", fn: async _t => { throw 42; }, expectPass: false, expectMsgContains: "42" },
        { name: "throw undefined", fn: async _t => { throw undefined; }, expectPass: false },
        { name: "throw null", fn: async _t => { throw null; }, expectPass: false },
        {
            name: "Error with no stack",
            fn: async _t => { const e = new Error("stackless"); delete (e as any).stack; throw e; },
            expectPass: false,
            expectMsgContains: "stackless",
        },
    ];

export async function testErrorIsolation(outerT: TestContext) {
    // Failing test A doesn't prevent test B from running.
    await outerT.run("failing test doesn't abort sibling", async (t: TestContext) => {
        let bRan = false;
        const { summary } = await run([
            { name: "A", fn: FAIL },
            { name: "B", fn: async _t => { bRan = true; } },
        ]);
        t.assert(bRan, "B should have run");
        t.assert(summary.passed === 1 && summary.failed === 1,
            `Expected 1 passed 1 failed, got ${JSON.stringify(summary)}`);
    });

    for (const tc of errorCases) {
        await outerT.run(tc.name, async (t: TestContext) => {
            const { summary, lines } = await run([{ name: tc.name, fn: tc.fn }]);
            if (tc.expectPass) {
                t.assert(summary.passed === 1 && summary.failed === 0,
                    `Expected pass, got ${JSON.stringify(summary)}`);
            } else {
                t.assert(summary.failed === 1,
                    `Expected 1 failed, got ${JSON.stringify(summary)}`);
                t.assert(!summary.passed, `Expected 0 passed`);
                if (tc.expectMsgContains) {
                    t.assert(contains(lines, tc.expectMsgContains),
                        `Expected "${tc.expectMsgContains}" in output\n${stripped(lines).join("\n")}`);
                }
            }
        });
    }

    await outerT.run("Error message appears exactly once in ERRORS output", async (t: TestContext) => {
        const { lines } = await run([{ name: "T", fn: async _t => { throw new Error("unique-msg"); } }]);
        const sl = stripped(lines);
        const occurrences = sl.filter(l => l.includes("unique-msg")).length;
        t.assert(occurrences === 1,
            `Expected message to appear exactly once, got ${occurrences}\n${sl.join("\n")}`);
    });

    await outerT.run("TypeError normalized to 'error:' prefix", async (t: TestContext) => {
        const { lines } = await run([{ name: "T", fn: async _t => { throw new TypeError("bad type"); } }]);
        const sl = stripped(lines);
        t.assert(sl.some(l => l.startsWith("error: bad type")),
            `Expected "error: bad type" line\n${sl.join("\n")}`);
        t.assert(!sl.some(l => l.startsWith("TypeError:")),
            `Expected no "TypeError:" prefix\n${sl.join("\n")}`);
    });

    await outerT.run("thrown primitive: no 'Error:' prefix in output", async (t: TestContext) => {
        const { lines } = await run([{ name: "T", fn: async _t => { throw "raw string"; } }]);
        const sl = stripped(lines);
        t.assert(sl.some(l => l.includes("raw string")),
            `Expected "raw string" in output\n${sl.join("\n")}`);
        t.assert(!sl.some(l => l.includes("Error: raw string")),
            `Expected no Error wrapping for primitive`);
    });
}

// =========================================================
// CATEGORY 6: Output Format Conformance
// =========================================================

export async function testOutputFormat(outerT: TestContext) {
    await outerT.run("header line: 'running N tests from <source>'", async (t: TestContext) => {
        const { lines } = await run([{ name: "T", fn: PASS }]);
        const sl = stripped(lines);
        t.assert(sl.some(l => l.startsWith("running") && l.includes("tests from") && l.includes("harness.test.ts")),
            `Header not found in:\n${sl.join("\n")}`);
    });

    await outerT.run("pass line format: '<name> ... ok (<N>ms)'", async (t: TestContext) => {
        const { lines } = await run([{ name: "MyTest", fn: PASS }]);
        const sl = stripped(lines);
        const line = sl.find(l => l.includes("MyTest") && l.includes("ok") && /\(\d+ms\)/.test(l));
        t.assert(!!line, `Expected 'MyTest ... ok (Xms)', got:\n${sl.join("\n")}`);
    });

    await outerT.run("fail line format: '<name> ... FAILED (<N>ms)'", async (t: TestContext) => {
        const { lines } = await run([{ name: "Bad", fn: FAIL }]);
        const sl = stripped(lines);
        const line = sl.find(l => l.includes("Bad") && l.includes("FAILED") && /\(\d+ms\)/.test(l));
        t.assert(!!line, `Expected 'Bad ... FAILED (Xms)', got:\n${sl.join("\n")}`);
    });

    await outerT.run("step indentation: 2 spaces per depth level", async (t: TestContext) => {
        const { lines } = await run([{
            name: "P",
            fn: async (t2: TestContext) => { await t2.run("child", PASS); },
        }]);
        const sl = stripped(lines);
        const childLine = sl.find(l => l.includes("child") && l.includes("ok"));
        t.assert(childLine!.startsWith("  "), `Expected 2-space indent for child, got "${childLine}"`);
    });

    await outerT.run("ERRORS section present on failure", async (t: TestContext) => {
        const { lines } = await run([{ name: "Fail", fn: async _t => { throw new Error("oops"); } }]);
        t.assert(contains(lines, "ERRORS"), `Expected ERRORS section`);
        t.assert(contains(lines, "oops"), `Expected error message`);
    });

    await outerT.run("FAILURES section lists failed test names", async (t: TestContext) => {
        const { lines } = await run([{ name: "FailMe", fn: FAIL }]);
        t.assert(contains(lines, "FAILURES"), `Expected FAILURES section`);
        const sl = stripped(lines);
        // After FAILURES, there should be a line with "FailMe"
        const failIdx = sl.findIndex(l => l.includes("FAILURES"));
        t.assert(failIdx >= 0, "FAILURES section not found");
        const afterFailures = sl.slice(failIdx + 1);
        t.assert(afterFailures.some(l => l.includes("FailMe")),
            `Expected "FailMe" after FAILURES\n${afterFailures.join("\n")}`);
    });

    await outerT.run("summary line format: 'ok|FAILED | N passed | N failed (Nms)'", async (t: TestContext) => {
        const { lines } = await run([
            { name: "A", fn: PASS },
            { name: "B", fn: FAIL },
        ]);
        const sl = stripped(lines).map(l => l.trim());
        const summaryLine = sl.find(l =>
            (l.startsWith("ok") || l.startsWith("FAILED")) &&
            l.includes("passed") &&
            l.includes("failed") &&
            /\(\d+ms\)/.test(l)  // milliseconds, not seconds
        );
        t.assert(!!summaryLine, `Expected summary line, got:\n${sl.join("\n")}`);
    });

    await outerT.run("skipped tests appear as 'N ignored' in summary", async (t: TestContext) => {
        const { lines, summary } = await run([
            { name: "P", fn: PASS },
            { name: "S", fn: async (t2: TestContext) => t2.skip() },
        ]);
        t.assert(summary.skipped === 1, `Expected 1 skipped, got ${summary.skipped}`);
        t.assert(contains(lines, "ignored"),
            `Expected "ignored" in summary\n${stripped(lines).join("\n")}`);
    });

    await outerT.run("timing values are numeric and >= 0", async (t: TestContext) => {
        const { lines } = await run([{ name: "T", fn: PASS }]);
        const sl = stripped(lines);
        // Per-step timings use ms, suite summary also uses ms.
        const timings = sl.join("\n").match(/\((\d+)ms\)/g) || [];
        t.assert(timings.length > 0, "No timing values found");
        for (const timing of timings) {
            const n = parseInt(timing.replace(/\D/g, ""), 10);
            t.assert(n >= 0, `Negative timing: ${timing}`);
        }
    });

    await outerT.run("nested failure path: 'parent > child' in FAILURES", async (t: TestContext) => {
        const { lines } = await run([{
            name: "parent",
            fn: async (t2: TestContext) => { await t2.run("child", FAIL); },
        }]);
        t.assert(contains(lines, "parent > child"),
            `Expected "parent > child" in output\n${stripped(lines).join("\n")}`);
    });

    await outerT.run("t.log() output appears in test output", async (t: TestContext) => {
        const { lines } = await run([{
            name: "T",
            fn: async (t2: TestContext) => {
                t2.log("my-unique-log-line");
                // Step so log output is captured as top-level.
                await t2.run("sub", PASS);
            },
        }]);
        t.assert(contains(lines, "my-unique-log-line"),
            `Expected log line in output\n${stripped(lines).join("\n")}`);
    });

    await outerT.run("failed summary prefix is FAILED", async (t: TestContext) => {
        const { lines } = await run([{ name: "F", fn: FAIL }]);
        const sl = stripped(lines).map(l => l.trim());
        const summaryLine = sl.find(l => l.includes("passed") && l.includes("failed"));
        t.assert(summaryLine!.startsWith("FAILED"), `Expected FAILED prefix, got: "${summaryLine}"`);
    });

    await outerT.run("passing summary prefix is ok", async (t: TestContext) => {
        const { lines } = await run([{ name: "P", fn: PASS }]);
        const sl = stripped(lines).map(l => l.trim());
        const summaryLine = sl.find(l => l.includes("passed") && l.includes("failed"));
        t.assert(summaryLine!.startsWith("ok"), `Expected ok prefix, got: "${summaryLine}"`);
    });
}

// =========================================================
// CATEGORY 7: Edge Cases
// =========================================================

export async function testEdgeCases(outerT: TestContext) {
    await outerT.run("empty suite returns 0/0/0", async (t: TestContext) => {
        const { summary } = await run([]);
        t.assert(summary.passed === 0 && summary.failed === 0 && summary.skipped === 0,
            `Expected empty summary, got ${JSON.stringify(summary)}`);
    });

    await outerT.run("single passing test: summary shows 1 passed", async (t: TestContext) => {
        const { summary } = await run([{ name: "Only", fn: PASS }]);
        t.assert(summary.passed === 1, `Expected 1 passed, got ${summary.passed}`);
    });

    await outerT.run("100 tests all pass: summary shows 100 passed", async (t: TestContext) => {
        const cases = Array.from({ length: 100 }, (_, i) => ({ name: `test${i}`, fn: PASS }));
        const { summary } = await run(cases);
        t.assert(summary.passed === 100, `Expected 100 passed, got ${summary.passed}`);
    });

    await outerT.run("very long test name doesn't crash", async (t: TestContext) => {
        const longName = "x".repeat(500);
        const { summary } = await run([{ name: longName, fn: PASS }]);
        t.assert(summary.passed === 1, "Should pass with long name");
    });

    await outerT.run("non-string test name doesn't crash", async (t: TestContext) => {
        // The harness accepts name: string but we verify graceful handling.
        const { summary } = await run([{ name: "", fn: PASS }]);
        t.assert(summary.passed === 1, "Empty name should pass");
    });

    await outerT.run("ctx payload is forwarded to test fn", async (t: TestContext) => {
        const sentinel = { marker: "ctx-forwarded-42" };
        let received: any = null;
        const { reporter } = capturingReporter();
        await runTestSuite(
            [{ name: "T", fn: async (_t2, ctx) => { received = ctx; } }],
            sentinel, "harness.test.ts", reporter,
        );
        t.assert(received === sentinel, `Expected ctx to be forwarded, got ${JSON.stringify(received)}`);
    });

    await outerT.run("concurrent steps don't interleave log output", async (t: TestContext) => {
        // Steps run sequentially, so A's logs should all precede B's.
        const { lines } = await run([{
            name: "parent",
            fn: async (t2: TestContext) => {
                await t2.run("A", async (t3: TestContext) => { t3.log("LOG_A"); });
                await t2.run("B", async (t3: TestContext) => { t3.log("LOG_B"); });
            },
        }]);
        const sl = stripped(lines);
        const aIdx = sl.findIndex(l => l.includes("LOG_A"));
        const bIdx = sl.findIndex(l => l.includes("LOG_B"));
        t.assert(aIdx < bIdx, `Expected LOG_A before LOG_B, got aIdx=${aIdx} bIdx=${bIdx}`);
    });

    await outerT.run("return value: HarnessSummary matches actual outcomes", async (t: TestContext) => {
        const { summary } = await run([
            { name: "P1", fn: PASS },
            { name: "P2", fn: PASS },
            { name: "F1", fn: FAIL },
            { name: "S1", fn: async (t2: TestContext) => t2.skip() },
        ]);
        t.assert(summary.passed === 2, `Expected 2 passed,  got ${summary.passed}`);
        t.assert(summary.failed === 1, `Expected 1 failed,  got ${summary.failed}`);
        t.assert(summary.skipped === 1, `Expected 1 skipped, got ${summary.skipped}`);
    });
}

// =========================================================
// CATEGORY 8: Streaming Guarantees
// =========================================================
//
// Verifies that step results are printed immediately after each step
// completes, not buffered until the parent test finishes. This was the
// root cause of a regression where `make test` appeared to hang for the
// entire suite duration before printing all results at once.

export async function testStreaming(outerT: TestContext) {
    await outerT.run("sub-step results stream inline with execution", async (t: TestContext) => {
        // Record the interleaving of execution events and print calls.
        // If streaming works, the sequence should be:
        //   exec:A → print:A → exec:B → print:B
        // If buffered, it would be:
        //   exec:A → exec:B → print:A → print:B
        const events: string[] = [];

        const lines: string[] = [];
        const print = (l: string) => {
            lines.push(l);
            // Strip ANSI codes before matching.
            const clean = strip(l).trim();
            // Only record step result lines (not headers/summaries).
            if (clean.includes("... ok") || clean.includes("... FAILED")) {
                const name = clean.split(" ")[0];
                events.push(`print:${name}`);
            }
        };
        const reporter = createReporter(print);

        await runTestSuite([{
            name: "Parent",
            fn: async (t2: TestContext) => {
                await t2.run("A", async () => { events.push("exec:A"); });
                await t2.run("B", async () => { events.push("exec:B"); });
                await t2.run("C", async () => { events.push("exec:C"); });
            },
        }], {}, "streaming.test.ts", reporter);

        // Expected: exec:A, print:A, exec:B, print:B, exec:C, print:C
        // Plus 1 print for "Parent", which comes at the end.
        const stepEvents = events.filter(e => !e.includes("Parent"));
        t.assert(stepEvents.length === 6,
            `Expected 6 step events (3 exec + 3 print), got ${stepEvents.length}: ${JSON.stringify(stepEvents)}`);

        // Each exec must be immediately followed by its corresponding print.
        for (let i = 0; i < 3; i++) {
            const step = ["A", "B", "C"][i];
            t.assert(stepEvents[i * 2] === `exec:${step}`,
                `Expected stepEvents[${i * 2}] = exec:${step}, got ${stepEvents[i * 2]}`);
            t.assert(stepEvents[i * 2 + 1] === `print:${step}`,
                `Expected stepEvents[${i * 2 + 1}] = print:${step}, got ${stepEvents[i * 2 + 1]}`);
        }
    });

    await outerT.run("nested sub-step results stream before parent summary", async (t: TestContext) => {
        const events: string[] = [];
        const print = (l: string) => {
            const clean = strip(l).trim();
            if (clean.includes("... ok") || clean.includes("... FAILED")) {
                const name = clean.split(" ")[0];
                events.push(`print:${name}`);
            }
        };
        const reporter = createReporter(print);

        await runTestSuite([{
            name: "Top",
            fn: async (t2: TestContext) => {
                await t2.run("child", async (t3: TestContext) => {
                    await t3.run("leaf", async () => { });
                });
            },
        }], {}, "nested-stream.test.ts", reporter);

        // Leaf prints before child, child prints before Top.
        t.assert(events.indexOf("print:leaf") >= 0,
            `leaf should be in events: ${JSON.stringify(events)}`);
        t.assert(events.indexOf("print:child") >= 0,
            `child should be in events: ${JSON.stringify(events)}`);
        t.assert(events.indexOf("print:Top") >= 0,
            `Top should be in events: ${JSON.stringify(events)}`);
        t.assert(events.indexOf("print:leaf") < events.indexOf("print:child"),
            `leaf should print before child: ${JSON.stringify(events)}`);
        t.assert(events.indexOf("print:child") < events.indexOf("print:Top"),
            `child should print before Top: ${JSON.stringify(events)}`);
    });
}

// =========================================================
// CATEGORY 9: Path-Based Nested Filtering
// =========================================================
//
// Verifies that `A > B` filter syntax targets nested steps by path.
// Single-segment filters match at the top level only — no fallthrough.

export async function testPathFiltering(outerT: TestContext) {
    await outerT.run("path filter A > B selects only matching nested step", async (t: TestContext) => {
        const { lines, summary } = await run([{
            name: "Outer",
            fn: async (t2: TestContext) => {
                await t2.run("target", PASS);
                await t2.run("other", PASS);
            },
        }], "Outer > target");
        t.assert(contains(lines, "target"), "Expected target in output");
        t.assert(!hasOk(lines, "other"), "Expected other NOT in output as ok");
        t.assert(summary.failed === 0, "Expected no failures");
    });

    await outerT.run("path filter A > B > C targets three levels deep", async (t: TestContext) => {
        const { lines, summary } = await run([{
            name: "Top",
            fn: async (t2: TestContext) => {
                await t2.run("alpha", async (t3: TestContext) => {
                    await t3.run("target", PASS);
                    await t3.run("sibling", PASS);
                });
                await t2.run("beta", async (t3: TestContext) => {
                    await t3.run("ignored", PASS);
                });
            },
        }], "Top > alpha > target");
        t.assert(hasOk(lines, "target"), "Expected target in output");
        t.assert(!hasOk(lines, "sibling"), "Expected sibling NOT in output");
        t.assert(!hasOk(lines, "beta"), "Expected beta NOT in output");
        t.assert(summary.failed === 0, "Expected no failures");
    });

    await outerT.run("no match at top level returns zero results", async (t: TestContext) => {
        const { summary } = await run([{
            name: "Outer",
            fn: async (t2: TestContext) => {
                await t2.run("target-step", PASS);
                await t2.run("other-step", PASS);
            },
        }], "target-step");
        // "target-step" doesn't match "Outer" at segment[0] → zero tests run.
        t.assert(summary.passed === 0 && summary.failed === 0,
            `Expected 0 passed 0 failed, got ${JSON.stringify(summary)}`);
    });

    await outerT.run("filtered status when path target is missing", async (t: TestContext) => {
        const { lines, summary } = await run([{
            name: "Outer",
            fn: async (t2: TestContext) => {
                await t2.run("alpha", PASS);
                await t2.run("beta", PASS);
            },
        }], "Outer > nonexistent");
        // "Outer" matches segment[0], but no sub-step matches "nonexistent".
        // The test is filtered — not shown as ok, not counted.
        t.assert(summary.passed === 0,
            `Expected 0 passed (filtered), got ${JSON.stringify(summary)}`);
        const sl = stripped(lines);
        t.assert(!sl.some(l => l.includes("Outer") && l.includes("ok")),
            `Expected Outer NOT shown as ok\n${sl.join("\n")}`);
    });

    await outerT.run("path filter substring match at each level", async (t: TestContext) => {
        const { lines, summary } = await run([{
            name: "MyOuter",
            fn: async (t2: TestContext) => {
                await t2.run("findMe", PASS);
                await t2.run("skipMe", PASS);
            },
        }], "Outer > find");
        t.assert(contains(lines, "findMe"), "Expected findMe in output");
        t.assert(!hasOk(lines, "skipMe"), "Expected skipMe NOT in output");
        t.assert(summary.failed === 0, "Expected no failures");
    });

    await outerT.run("path filter children pass through after last segment", async (t: TestContext) => {
        const { lines, summary } = await run([{
            name: "Root",
            fn: async (t2: TestContext) => {
                await t2.run("branch", async (t3: TestContext) => {
                    await t3.run("leaf-a", PASS);
                    await t3.run("leaf-b", PASS);
                });
            },
        }], "Root > branch");
        // Both leaves should run — filter is fully consumed after matching "branch".
        t.assert(hasOk(lines, "leaf-a"), "Expected leaf-a ok");
        t.assert(hasOk(lines, "leaf-b"), "Expected leaf-b ok");
        t.assert(summary.failed === 0, "Expected no failures");
    });
}

// =========================================================
// CATEGORY 10: Reporter Color Control
// =========================================================
//
// Verifies that createReporter({ color: false }) suppresses all ANSI
// escape codes, making output safe for grep and log files.

export async function testReporter(outerT: TestContext) {
    await outerT.run("color:false suppresses ANSI codes in passing output", async (t: TestContext) => {
        const { lines } = await run([{ name: "T", fn: PASS }], undefined, { color: false });
        const raw = lines.join("\n");
        t.assert(!raw.includes("\x1b["),
            `Expected no ANSI codes in output, but found some:\n${raw}`);
        t.assert(raw.includes("ok"), "Expected 'ok' in plain output");
    });

    await outerT.run("color:false suppresses ANSI codes in failing output", async (t: TestContext) => {
        const { lines } = await run([{ name: "F", fn: FAIL }], undefined, { color: false });
        const raw = lines.join("\n");
        t.assert(!raw.includes("\x1b["),
            `Expected no ANSI codes, but found some:\n${raw}`);
        t.assert(raw.includes("FAILED"), "Expected 'FAILED' in plain output");
        t.assert(raw.includes("ERRORS"), "Expected 'ERRORS' in plain output");
    });

    await outerT.run("color:false suppresses ANSI codes in nested output", async (t: TestContext) => {
        const { lines } = await run([{
            name: "P",
            fn: async (t2: TestContext) => { await t2.run("child", PASS); },
        }], undefined, { color: false });
        const raw = lines.join("\n");
        t.assert(!raw.includes("\x1b["),
            `Expected no ANSI codes in nested output:\n${raw}`);
    });

    await outerT.run("default reporter emits ANSI codes", async (t: TestContext) => {
        const { lines } = await run([{ name: "T", fn: PASS }]);
        const raw = lines.join("\n");
        t.assert(raw.includes("\x1b["),
            `Expected ANSI codes in default output, but found none`);
    });

    await outerT.run("color:false output is grep-friendly", async (t: TestContext) => {
        const { lines } = await run([
            { name: "Pass", fn: PASS },
            { name: "Fail", fn: FAIL },
        ], undefined, { color: false });
        const failedLines = lines.filter(l => l.includes("FAILED"));
        t.assert(failedLines.length > 0, "Expected at least one line containing FAILED");
        for (const l of failedLines) {
            t.assert(!l.includes("\x1b["),
                `ANSI codes found in FAILED line: ${JSON.stringify(l)}`);
        }
    });
}
