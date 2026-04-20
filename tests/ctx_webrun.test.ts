// ctx_webrun.test.ts — Phase A integration tests for ctx.webrun().
//
// All cases are declared as data. The runner interprets each case's mode to
// set up options and verify outcomes — one behavior per case.

import { webrun } from "webrun/ctx";
import type { TestContext } from "../src/test_harness.ts";

// ── Case schema ───────────────────────────────────────────────────────────────

type BufferedCase = {
    mode: "buffered";
    name: string;
    code: string;
    options?: { timeoutMillis?: number };
    exitCode?: number;
    stdoutContains?: string;
    stderrContains?: string;
    noStdout?: true;  // streaming: result must not have stdout field
};

type StreamCase = {
    mode: "stream";
    name: string;
    code: string;
    pipe: "stdout" | "stderr";
    contains: string;
    ordered?: string[];  // if set, assert these substrings appear in order
};

type SignalCase = {
    mode: "signal";
    name: string;
    code: string;
    preAbort: boolean;   // true = abort before call, false = abort after 50ms
    exitCode: number;
};

type EvalCase = BufferedCase | StreamCase | SignalCase;

// ── Case table ────────────────────────────────────────────────────────────────

const cases: EvalCase[] = [
    // Buffered stdout
    {
        mode: "buffered", name: "stdout buffering: captures console.log output",
        code: "console.log('hello-buf');",
        stdoutContains: "hello-buf", exitCode: 0,
    },
    // Buffered stderr
    {
        mode: "buffered", name: "stderr buffering: captures console.error output",
        code: "console.error('err-buf');",
        stderrContains: "err-buf",
    },
    // Exit code propagation via ctx.exit
    {
        mode: "buffered", name: "exit code propagation: ctx.exit(42)",
        code: `import { exit } from "webrun/ctx"; exit(42);`,
        exitCode: 42,
    },
    // Clean process
    {
        mode: "buffered", name: "exit code 0 for clean process",
        code: "", exitCode: 0,
    },
    // Timeout — exits 143
    {
        mode: "buffered", name: "timeoutMillis: hanging process exits with code 143",
        code: "await new Promise(() => {});",
        options: { timeoutMillis: 500 }, exitCode: 143,
    },
    // Timeout — fast process not killed
    {
        mode: "buffered", name: "timeoutMillis: process that finishes before timeout exits normally",
        code: "console.log('fast');",
        options: { timeoutMillis: 5000 }, exitCode: 0, stdoutContains: "fast",
    },
    // Eval: multiline
    {
        mode: "buffered", name: "--eval: multiline code executes correctly",
        code: "const x = 1 + 2; console.log('result=' + x);",
        stdoutContains: "result=3",
    },
    // Eval: thrown error → non-zero
    {
        mode: "buffered", name: "--eval: thrown error produces non-zero exit code",
        code: "throw new Error('boom');",
        exitCode: 1,
    },

    // Streaming stdout
    {
        mode: "stream", name: "streaming stdout: chunks arrive before resolve",
        code: "console.log('stream-out');",
        pipe: "stdout", contains: "stream-out",
    },
    // Streaming stderr
    {
        mode: "stream", name: "streaming stderr: chunks arrive before resolve",
        code: "console.error('stream-err');",
        pipe: "stderr", contains: "stream-err",
    },
    // Streaming: order preserved
    {
        mode: "stream", name: "streaming: multiple chunks arrive in order",
        code: "console.log('A'); console.log('B'); console.log('C');",
        pipe: "stdout", contains: "A",
        ordered: ["A", "B", "C"],
    },

    // Signal: pre-aborted
    {
        mode: "signal", name: "signal: pre-aborted exits immediately with code 143",
        code: "await new Promise(() => {});",
        preAbort: true, exitCode: 143,
    },
    // Signal: abort during execution
    {
        mode: "signal", name: "signal: abort during execution terminates process",
        code: "await new Promise(() => {});",
        preAbort: false, exitCode: 143,
    },
];

// ── Runner ────────────────────────────────────────────────────────────────────

async function runCase(c: EvalCase, t: TestContext): Promise<void> {
    if (c.mode === "buffered") {
        const res = await webrun(["--eval", c.code], c.options ?? {});
        if (c.exitCode !== undefined) {
            t.assert(res.exitCode === c.exitCode, `exitCode: expected ${c.exitCode}, got ${res.exitCode}`);
        }
        if (c.stdoutContains !== undefined) {
            t.assert(res.stdout?.includes(c.stdoutContains),
                `stdout: expected "${c.stdoutContains}", got: ${JSON.stringify(res.stdout)}`);
        }
        if (c.stderrContains !== undefined) {
            t.assert(res.stderr?.includes(c.stderrContains),
                `stderr: expected "${c.stderrContains}", got: ${JSON.stringify(res.stderr)}`);
        }
        return;
    }

    if (c.mode === "stream") {
        const dec = new TextDecoder();
        let collected = "";
        const stream = new WritableStream<Uint8Array>({
            write(chunk) { collected += dec.decode(chunk, { stream: true }); },
        });
        const opts = c.pipe === "stdout" ? { stdout: stream } : { stderr: stream };
        const res = await webrun(["--eval", c.code], opts);
        t.assert(res[c.pipe] === undefined, `streaming mode must not return ${c.pipe} field`);
        t.assert(collected.includes(c.contains),
            `stream: expected "${c.contains}", got: ${JSON.stringify(collected)}`);
        if (c.ordered) {
            let last = -1;
            for (const sub of c.ordered) {
                const idx = collected.indexOf(sub, last + 1);
                t.assert(idx > last, `ordering: expected "${sub}" after position ${last}, got ${idx} in: ${JSON.stringify(collected)}`);
                last = idx;
            }
        }
        return;
    }

    if (c.mode === "signal") {
        const ac = new AbortController();
        if (c.preAbort) {
            ac.abort();
        } else {
            setTimeout(() => ac.abort(), 50);
        }
        const res = await webrun(["--eval", c.code], { signal: ac.signal });
        t.assert(res.exitCode === c.exitCode, `signal: expected exitCode ${c.exitCode}, got ${res.exitCode}`);
        return;
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function testCtxWebrun(outerT: TestContext) {
    for (const c of cases) {
        await outerT.run(c.name, (t) => runCase(c, t));
    }
}
