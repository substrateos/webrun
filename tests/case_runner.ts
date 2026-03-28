// Shared case runner for directory-based test discovery.
// Used by cli.test.ts, api.test.ts, bindings.test.ts, and sandbox.test.ts.

import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

interface ContainsRule { contains?: string; absent?: string }

interface HttpProbe {
    method?: string;
    path: string;
    request_headers?: Record<string, string>;
    request_body?: string;
    status?: number;
    headers?: Record<string, string>;
    body?: ContainsRule[];
}

export interface CaseExpect {
    exit_code: number | "nonzero";
    stdout?: ContainsRule[];
    stderr?: ContainsRule[];
    ready?: { stdout?: ContainsRule[]; stderr?: ContainsRule[] };
    http?: HttpProbe[];
    files?: Array<{ path: string; contains?: string; exists?: boolean }>;
}

export interface CaseDefinition {
    name: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    signal?: string;
    timeout_ms?: number;
    expect: CaseExpect;
}

export function copyDirRecursive(t: any, src: string, dest: string) {
    for (const entry of t.testsys.readDirSync(src)) {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);
        if (entry.isDirectory) {
            t.testsys.mkdirSync(destPath, { recursive: true });
            copyDirRecursive(t, srcPath, destPath);
        } else {
            t.testsys.writeFileSync(destPath, t.testsys.readFileSync(srcPath));
        }
    }
}

// Discover all cases.json files recursively under rootDir.
export function discoverCases(t: any, rootDir: string): { dir: string; def: CaseDefinition }[] {
    const cases: { dir: string; def: CaseDefinition }[] = [];
    let entries: any[];
    try { entries = [...t.testsys.readDirSync(rootDir)]; } catch { return cases; }
    for (const entry of entries) {
        if (!entry.isDirectory) continue;
        const caseDir = join(rootDir, entry.name);
        try {
            const raw = t.testsys.readTextFileSync(join(caseDir, "cases.json"));
            const defs: CaseDefinition[] = JSON.parse(raw);
            for (const def of defs) {
                cases.push({ dir: caseDir, def });
            }
        } catch {
            // Recurse into subdirectories (e.g. sandbox/webrun/, sandbox/os/).
            cases.push(...discoverCases(t, caseDir));
        }
    }
    return cases;
}

// Run a batch-mode case: spawn, wait for exit, assert.
export async function runBatchCase(t: any, caseDir: string, def: CaseDefinition): Promise<void> {
    const runDir = t.testsys.realPathSync(t.testsys.makeTempDirSync({ prefix: "case_" }));
    copyDirRecursive(t, caseDir, runDir);

    const cwd = def.cwd ? join(runDir, def.cwd) : runDir;
    const args = def.args || ["--module", "main.ts"];

    const proc = new t.testsys.Command(t.WORKER_BIN, {
        args, cwd, env: def.env, stdout: "piped", stderr: "piped"
    }).spawn();

    const decoder = new TextDecoder();
    let stdout = "", stderr = "";

    const readStream = async (stream: any, isStdout: boolean) => {
        const reader = stream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (isStdout) stdout += decoder.decode(value);
                else stderr += decoder.decode(value);
            }
        } catch (_) {}
    };

    const timer = setTimeout(() => {
        try { proc.kill("SIGTERM"); } catch (_) {}
    }, 30_000);

    const [status] = await Promise.all([
        proc.status,
        readStream(proc.stdout, true),
        readStream(proc.stderr, false)
    ]);

    clearTimeout(timer);
    try { t.testsys.removeSync(runDir, { recursive: true }); } catch (_) {}

    assertExitCode(def.expect, status.code, stdout, stderr);
    assertOutput(def.expect, stdout, stderr);
}

// Run a signal-mode case: stream, wait for ready, HTTP probe, signal, assert.
export async function runSignalCase(t: any, caseDir: string, def: CaseDefinition): Promise<void> {
    const runDir = t.testsys.realPathSync(t.testsys.makeTempDirSync({ prefix: "case_" }));
    copyDirRecursive(t, caseDir, runDir);

    const cwd = def.cwd ? join(runDir, def.cwd) : runDir;
    const args = def.args || ["--serve", "."];

    const proc = new t.testsys.Command(t.WORKER_BIN, {
        args, cwd, env: def.env, stdout: "piped", stderr: "piped"
    }).spawn();

    const decoder = new TextDecoder();
    let stdout = "", stderr = "";
    const deadline = def.timeout_ms ?? 10_000;

    let onChunk: (() => void) | null = null;
    const readyPromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            try { proc.kill("SIGTERM"); } catch (_) {}
            reject(new Error(`Timed out after ${deadline}ms waiting for ready\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        }, deadline);

        if (!def.expect.ready) {
            clearTimeout(timer);
            resolve();
            return;
        }

        onChunk = () => {
            const ready = def.expect.ready!;
            const stdoutOk = !ready.stdout || ready.stdout.every(r => !r.contains || stdout.includes(r.contains));
            const stderrOk = !ready.stderr || ready.stderr.every(r => !r.contains || stderr.includes(r.contains));
            if (stdoutOk && stderrOk) {
                clearTimeout(timer);
                onChunk = null;
                resolve();
            }
        };
    });

    const readStream = async (stream: any, isStdout: boolean) => {
        const reader = stream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (isStdout) stdout += decoder.decode(value);
                else stderr += decoder.decode(value);
                if (onChunk) onChunk();
            }
        } catch (_) {}
    };

    const stdoutDone = readStream(proc.stdout, true);
    const stderrDone = readStream(proc.stderr, false);

    try {
        await readyPromise;
    } catch (e) {
        await Promise.allSettled([proc.status, stdoutDone, stderrDone]);
        try { t.testsys.removeSync(runDir, { recursive: true }); } catch (_) {}
        throw e;
    }

    // HTTP probes.
    let port: number | undefined;
    const portMatch = stdout.match(/serving at https?:\/\/[^:]+:(\d+)/);
    if (portMatch) port = parseInt(portMatch[1], 10);

    if (def.expect.http && port) {
        for (const probe of def.expect.http) {
            const url = `http://127.0.0.1:${port}${probe.path}`;
            const res = await t.testsys.nativeFetch(url, {
                method: probe.method || "GET",
                headers: probe.request_headers,
                body: probe.request_body,
            });
            const body = await res.text();

            if (probe.status !== undefined && res.status !== probe.status) {
                throw new Error(`HTTP ${probe.method || "GET"} ${probe.path}: expected status ${probe.status}, got ${res.status}\nBody: ${body}`);
            }
            if (probe.headers) {
                for (const [name, expected] of Object.entries(probe.headers)) {
                    const actual = res.headers.get(name);
                    if (actual !== expected) {
                        throw new Error(`HTTP ${probe.path}: expected header "${name}: ${expected}", got "${actual}"`);
                    }
                }
            }
            if (probe.body) {
                for (const rule of probe.body) {
                    if (rule.contains && !body.includes(rule.contains)) {
                        throw new Error(`HTTP ${probe.path}: expected body to contain "${rule.contains}"\nBody: ${body}`);
                    }
                    if (rule.absent && body.includes(rule.absent)) {
                        throw new Error(`HTTP ${probe.path}: expected body to NOT contain "${rule.absent}"\nBody: ${body}`);
                    }
                }
            }
        }
    }

    try { proc.kill(def.signal || "SIGTERM"); } catch (_) {}
    const [status] = await Promise.all([proc.status, stdoutDone, stderrDone]);
    try { t.testsys.removeSync(runDir, { recursive: true }); } catch (_) {}

    assertExitCode(def.expect, status.code, stdout, stderr);
    assertOutput(def.expect, stdout, stderr);
}

function assertExitCode(expect: CaseExpect, code: number, stdout: string, stderr: string) {
    if (expect.exit_code === "nonzero") {
        if (code === 0) throw new Error(`Expected nonzero exit code, got 0\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    } else {
        if (code !== expect.exit_code) throw new Error(`Expected exit code ${expect.exit_code}, got ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    }
}

function assertOutput(expect: CaseExpect, stdout: string, stderr: string) {
    const combined = stdout + "\n" + stderr;
    for (const rule of expect.stdout || []) {
        if (rule.contains && !combined.includes(rule.contains)) {
            throw new Error(`Expected stdout to contain "${rule.contains}"\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
        }
        if (rule.absent && combined.includes(rule.absent)) {
            throw new Error(`Expected stdout to NOT contain "${rule.absent}"\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
        }
    }
    for (const rule of expect.stderr || []) {
        if (rule.contains && !combined.includes(rule.contains)) {
            throw new Error(`Expected stderr to contain "${rule.contains}"\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
        }
        if (rule.absent && combined.includes(rule.absent)) {
            throw new Error(`Expected stderr to NOT contain "${rule.absent}"\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
        }
    }
}
