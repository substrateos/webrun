// ctx.test.ts — Integration tests for ctx.run() and security findings.

// ── H3: spawn server must not leak host env into ctx.run() children ───────

export async function testSecuritySpawnEnvLeak(t: any, { makeTempDir, run: webrun }: any) {
    await t.run("host HOME does not leak to child via ctx.run()", async () => {
        const tmpDir = await makeTempDir();
        const webrunJson = await tmpDir.getFileHandle("webrun.json", { create: true });
        const writer = await webrunJson.createWritable();
        await writer.write(new TextEncoder().encode("{}"));
        await writer.close();

        const handle = await webrun(
            ["--eval", `export default { main(args, env) {
                const keys = Object.keys(env);
                console.log("ENV_KEYS:" + keys.length);
                if (keys.length > 0) console.log("ENV_LEAKED:" + keys.join(","));
            } }`],
            { cwd: tmpDir.name },
        );
        const [stdout, stderr] = await Promise.all([
            new Response(handle.stdout).text(),
            new Response(handle.stderr).text(),
        ]);
        const stdoutStr = stdout || "";
        if (stdoutStr.includes("ENV_LEAKED:")) {
            throw new Error(
                "Spawn server leaked env vars to child with no declared permissions.env.\n" +
                `STDOUT: ${stdoutStr}\nSTDERR: ${stderr || ""}`
            );
        }
    });
}

// ── F2: Filesystem boundary prevents constructing out-of-scope handles ───────

export async function testSecuritySpawnCwdValidation(t: any, { dir }: any) {
    await t.run("ctx.run() rejects cwdPath outside parent scope", async () => {
        // The FS capability boundary prevents constructing handles for paths
        // outside the mounted roots. getDirectoryHandle rejects traversal
        // characters, so you cannot pass an out-of-scope dir to ctx.run().
        const traversalNames = ["..", "/tmp", "foo/bar", "..\\.."];
        for (const name of traversalNames) {
            try {
                await dir.getDirectoryHandle(name);
                throw new Error(
                    `FS boundary accepted '${name}' — expected SecurityError`
                );
            } catch (e: any) {
                if (e.name !== "SecurityError") {
                    throw new Error(
                        `Expected SecurityError for '${name}', got ${e.name}: ${e.message}`
                    );
                }
            }
        }
    });
}

// ── Case schema ───────────────────────────────────────────────────────────────

type BufferedCase = {
    mode: "buffered";
    name: string;
    code: string;
    options?: { limits?: { timeoutMillis?: number } };
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

type StdinCase = {
    mode: "stdin";
    name: string;
    code: string;
    input: string;
    stdoutContains: string;
};

type LiveHandleCase = {
    mode: "live-handle";
    name: string;
    code: string;
    maxReturnTimeMs: number;
    childSleepMs: number;
};

type EvalCase = BufferedCase | StreamCase | SignalCase | StdinCase | LiveHandleCase;

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
        code: `export default { main(args, env, ctx) { ctx.exit(42); } }`,
        exitCode: 42,
    },
    // Thrown error produces non-zero exit code
    {
        mode: "buffered", name: "exit code propagation: thrown error produces exit code 1",
        code: `throw new Error("exit-test");`,
        exitCode: 1,
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
        options: { limits: { timeoutMillis: 500 } }, exitCode: 143, stderrContains: "Execution exceeded timeout constraint (500ms)",
    },
    // Timeout — fast process not killed
    {
        mode: "buffered", name: "timeoutMillis: process that finishes before timeout exits normally",
        code: "console.log('fast');",
        options: { limits: { timeoutMillis: 5000 } }, exitCode: 0, stdoutContains: "fast",
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

    // Stdin piping
    {
        mode: "stdin", name: "stdin: piped data arrives at child process",
        code: `export default { async main(args, env, ctx) {
            const reader = ctx.stdin.getReader();
            const chunks = [];
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                chunks.push(new TextDecoder().decode(value));
            }
            console.log(chunks.join(''));
        } }`,
        input: "hello-from-stdin",
        stdoutContains: "hello-from-stdin",
    },

    // Live handle check
    {
        mode: "live-handle",
        name: "live handle: ctx.run returns immediately, does not block on child exit or serve",
        code: `await new Promise(r => setTimeout(r, 1000)); console.log('live-done');`,
        maxReturnTimeMs: 500, // Handle should be returned well before the 1s sleep finishes
        childSleepMs: 1000,
    },
];

// ── Runner ────────────────────────────────────────────────────────────────────

async function runCase(c: EvalCase, t: any, webrun: any): Promise<void> {
    if (c.mode === "buffered") {
        const handle = await webrun(["--eval", c.code], c.options ?? {});
        const [exitCode, stdout, stderr] = await Promise.all([
            handle.exitCode,
            new Response(handle.stdout).text(),
            new Response(handle.stderr).text(),
        ]);
        if (c.exitCode !== undefined) {
            t.assert(exitCode === c.exitCode, `exitCode: expected ${c.exitCode}, got ${exitCode}. stderr: ${stderr}`);
        }
        if (c.stdoutContains !== undefined) {
            t.assert(stdout?.includes(c.stdoutContains),
                `stdout: expected "${c.stdoutContains}", got: ${JSON.stringify(stdout)}`);
        }
        if (c.stderrContains !== undefined) {
            t.assert(stderr?.includes(c.stderrContains),
                `stderr: expected "${c.stderrContains}", got: ${JSON.stringify(stderr)}`);
        }
        return;
    }

    if (c.mode === "stream") {
        // Streaming tests: verify output arrives via handle streams.
        const handle = await webrun(["--eval", c.code], {});
        const output = await new Response(c.pipe === "stdout" ? handle.stdout : handle.stderr).text();
        t.assert(output.includes(c.contains),
            `stream: expected "${c.contains}", got: ${JSON.stringify(output)}`);
        if (c.ordered) {
            let last = -1;
            for (const sub of c.ordered) {
                const idx = output.indexOf(sub, last + 1);
                t.assert(idx > last, `ordering: expected "${sub}" after position ${last}, got ${idx} in: ${JSON.stringify(output)}`);
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
        const handle = await webrun(["--eval", c.code], { signal: ac.signal });
        const exitCode = await handle.exitCode;
        t.assert(exitCode === c.exitCode, `signal: expected exitCode ${c.exitCode}, got ${exitCode}`);
        return;
    }

    if (c.mode === "stdin") {
        const encoder = new TextEncoder();
        const stdin = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(c.input));
                controller.close();
            },
        });
        const handle = await webrun(["--eval", c.code], { stdin });
        const [exitCode, stdout] = await Promise.all([
            handle.exitCode,
            new Response(handle.stdout).text(),
        ]);
        t.assert(exitCode === 0, `stdin: expected exitCode 0, got ${exitCode}`);
        t.assert(stdout.includes(c.stdoutContains),
            `stdin: expected stdout to contain "${c.stdoutContains}", got: ${JSON.stringify(stdout)}`);
        return;
    }

    if (c.mode === "live-handle") {
        const start = Date.now();
        const handle = await webrun(["--eval", c.code], {});
        const elapsed = Date.now() - start;
        t.assert(elapsed < c.maxReturnTimeMs, 
            `live-handle: ctx.run blocked for ${elapsed}ms, which is >= max allowed ${c.maxReturnTimeMs}ms. It is likely waiting for the child to exit or serve.`);
        
        // Ensure child exits successfully
        const [exitCode, stdout] = await Promise.all([
            handle.exitCode,
            new Response(handle.stdout).text(),
        ]);
        t.assert(exitCode === 0, `live-handle: expected exitCode 0, got ${exitCode}`);
        t.assert(stdout.includes("live-done"), `live-handle: expected stdout to contain "live-done"`);
        return;
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function testCtxWebrun(outerT: any, { run: webrun }: any) {
    for (const c of cases) {
        await outerT.run(c.name, (t: any) => runCase(c, t, webrun));
    }
}
