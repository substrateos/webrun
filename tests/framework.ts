// NOTE: We use absolute URLs for dependencies instead of deno.json import maps
// because this module is dynamically evaluated inside restricted Deno Workers.
// Worker instances do not automatically inherit the host's import map, and
// bare specifiers would fail to resolve without 'deno bundle'.
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

export interface TestCase {
    name: string;

    /** Executable sandbox payload closure or raw ES module string evaluating against `ctx` natively */
    scripts?: Record<string, string | ((ctx: any) => Promise<void>)>;

    /** Define a virtual file tree for the project root before running the script */
    files?: Record<string, string>;

    /**
     * Optional configuration file(s) to write to the test environment.
     * The key should be the directory path relative to the test root (e.g. "." or "child").
     * The value should be the JSON configuration.
     */
    configs?: Record<string, any>;

    /** Specific environment variables to inject into the host execution context */
    env?: Record<string, string>;

    /** Specific command line arguments to forward via the explicit parameter vector */
    args?: string[];

    /** Specific PWD sub-directory relative to the test root to invoke the worker from */
    cwd?: string;

    /** Hook to perform actions in runDir before execution */
    preflight?: (runDir: string, t: any) => Promise<void>;

    /** Expected sandbox boundary assertions */
    expectCode: number | "nonzero";
    expectStdout?: string;
    expectStderr?: string | string[];
}

export async function runTest(t: any, tc: TestCase) {
    const { Deno, WORKER_BIN } = t;

    const runDir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: "sandbox_tb_" }));

    const tree: Record<string, string> = { ...(tc.files || {}) };

    if (tc.configs) {
        for (const [dir, config] of Object.entries(tc.configs)) {
            tree[join(dir, "webrun.json")] = typeof config === "string" ? config : JSON.stringify(config);
        }
    }

    if (tc.scripts) {
        for (const [filename, content] of Object.entries(tc.scripts)) {
            tree[filename] = typeof content === "function" ?
                `export default async function(ctx) { await (${content.toString()})(ctx); }` :
                content;
        }
    }

    for (const [relPath, content] of Object.entries(tree)) {
        const absPath = join(runDir, relPath);
        Deno.mkdirSync(dirname(absPath), { recursive: true });
        Deno.writeTextFileSync(absPath, content);
    }

    Deno.mkdirSync(join(runDir, "src"), { recursive: true });

    if (tc.preflight) {
        await tc.preflight(runDir, t);
    }
    const testCwd = tc.cwd ? join(runDir, tc.cwd) : runDir;
    const cmd = new Deno.Command(WORKER_BIN, {
        args: tc.args || [],
        cwd: testCwd,
        env: tc.env,
        stdout: "piped",
        stderr: "piped"
    });

    const output = await cmd.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);

    // Clean up ephemeral logic
    try { Deno.removeSync(runDir, { recursive: true }); } catch (_) { }

    if (tc.expectCode === "nonzero") {
        if (output.code === 0) {
            console.error(`[${tc.name}] FAILED. Expected non-zero code, got 0`);
            console.error("STDOUT:", stdout);
            console.error("STDERR:", stderr);
            throw new Error("Expected non-zero exit code");
        }
    } else {
        if (output.code !== tc.expectCode) {
            console.error(`[${tc.name}] FAILED. Expected code ${tc.expectCode}, got ${output.code}`);
            console.error("STDOUT:", stdout);
            console.error("STDERR:", stderr);
        }
        assertEquals(output.code, tc.expectCode);
    }

    const combinedOutput = stdout + "\n" + stderr;

    if (tc.expectStdout) {
        const exps = Array.isArray(tc.expectStdout) ? tc.expectStdout : [tc.expectStdout];
        for (const exp of exps) {
            assertStringIncludes(combinedOutput, exp);
        }
    }
    if (tc.expectStderr) {
        const exps = Array.isArray(tc.expectStderr) ? tc.expectStderr : [tc.expectStderr];
        for (const exp of exps) {
            assertStringIncludes(combinedOutput, exp);
        }
    }
}

export async function runTests(t: any, tcs: TestCase[]) {
    for (const tc of tcs) {
        await t.run(tc.name, async () => {
            await runTest(t, tc);
        });
    }
}
