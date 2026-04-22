// Shared case runner for directory-based test discovery.
// Used by cli.test.ts, api.test.ts, and bindings.test.ts.
//
// All operations use the webrun/ctx API:
//   - Fixture discovery via FileSystemDirectoryHandle (ctx.dir)
//   - Temp dirs via ctx.makeTempDir()
//   - Process spawning via ctx.webrun()
//
// CLI-subprocess tests (runner=cli, runner=cli-signal) are in tests/external/.

import { dir, makeTempDir, webrun } from "webrun/ctx";

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
    /** Declares which runner this case requires.
     *  - "cli": tests/external (host subprocess, batch)
     *  - "cli-signal": tests/external (host subprocess, streaming + signal)
     *  - absent: auto-selected (runSignalCase if signal, else runBatchCase) */
    runner?: "cli" | "cli-signal";
    expect: CaseExpect;
}

// ── FSDH Helpers ─────────────────────────────────────────────────────────────

type DirHandle = any;  // FileSystemDirectoryHandle

/** Copy all entries from src to dest, recursively. */
export async function copyDir(src: DirHandle, dest: DirHandle): Promise<void> {
    for await (const [name, handle] of src.entries()) {
        if (handle.kind === "directory") {
            const sub = await dest.getDirectoryHandle(name, { create: true });
            await copyDir(handle, sub);
        } else {
            const file = await handle.getFile();
            const data = new Uint8Array(await file.arrayBuffer());
            const destFile = await dest.getFileHandle(name, { create: true });
            const writable = await destFile.createWritable();
            await writable.write(data);
            await writable.close();
        }
    }
}

/** Read a text file from a directory handle. */
async function readText(dir: DirHandle, name: string): Promise<string> {
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    return file.text();
}

/** Navigate to a subdirectory handle by walking path segments. */
async function subdir(parent: DirHandle, path: string): Promise<DirHandle> {
    let current = parent;
    for (const segment of path.split("/").filter(Boolean)) {
        current = await current.getDirectoryHandle(segment);
    }
    return current;
}

// ── Case Discovery ───────────────────────────────────────────────────────────

/** Discover all cases.json files recursively under a directory handle. */
export async function discoverCases(
    rootDir: DirHandle
): Promise<{ dir: DirHandle; def: CaseDefinition }[]> {
    const cases: { dir: DirHandle; def: CaseDefinition }[] = [];
    for await (const [name, handle] of rootDir.entries()) {
        if (handle.kind !== "directory") continue;
        try {
            const raw = await readText(handle, "cases.json");
            const defs: CaseDefinition[] = JSON.parse(raw);
            for (const def of defs) cases.push({ dir: handle, def });
        } catch {
            // Recurse into subdirectories.
            cases.push(...await discoverCases(handle));
        }
    }
    return cases;
}

// ── Runners ──────────────────────────────────────────────────────────────────

/** Run a batch-mode case: spawn via ctx.webrun(), wait for exit, assert. */
export async function runBatchCase(caseDir: DirHandle, def: CaseDefinition): Promise<void> {
    const runDir = await makeTempDir();
    await copyDir(caseDir, runDir);

    const cwd = def.cwd ? await subdir(runDir, def.cwd) : runDir;
    const args = def.args || ["--module", "main.ts"];

    const result = await webrun(args, {
        cwd,
        env: def.env,
        timeoutMillis: 30_000,
    });

    assertExitCode(def.expect, result.exitCode, result.stdout || "", result.stderr || "");
    assertOutput(def.expect, result.stdout || "", result.stderr || "");
}

/** Run a signal-mode case: stream output, wait for ready, HTTP probe, signal, assert. */
export async function runSignalCase(caseDir: DirHandle, def: CaseDefinition): Promise<void> {
    const runDir = await makeTempDir();
    await copyDir(caseDir, runDir);

    const cwd = def.cwd ? await subdir(runDir, def.cwd) : runDir;
    const args = def.args || ["--serve", "."];
    const deadline = def.timeout_ms ?? 10_000;

    // Create writable streams for stdout/stderr capture.
    let stdout = "", stderr = "";
    let onChunk: (() => void) | null = null;

    const stdoutStream = new WritableStream<Uint8Array>({
        write(chunk) {
            stdout += new TextDecoder().decode(chunk);
            if (onChunk) onChunk();
        }
    });
    const stderrStream = new WritableStream<Uint8Array>({
        write(chunk) {
            stderr += new TextDecoder().decode(chunk);
            if (onChunk) onChunk();
        }
    });

    const controller = new AbortController();

    const resultPromise = webrun(args, {
        cwd,
        env: def.env,
        stdout: stdoutStream,
        stderr: stderrStream,
        signal: controller.signal,
        timeoutMillis: deadline + 5_000,
    });

    // Wait for the ready condition.
    if (def.expect.ready) {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                controller.abort();
                reject(new Error(`Timed out after ${deadline}ms waiting for ready\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
            }, deadline);

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
            // Check immediately in case ready output was already captured.
            onChunk();
        });
    }

    // HTTP probes.
    let port: number | undefined;
    const portMatch = stdout.match(/serving at https?:\/\/[^:]+:(\d+)/);
    if (portMatch) port = parseInt(portMatch[1], 10);

    if (def.expect.http && port) {
        for (const probe of def.expect.http) {
            const url = `http://127.0.0.1:${port}${probe.path}`;
            const res = await fetch(url, {
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

    // Signal the process to stop and wait for exit.
    controller.abort(def.signal || "SIGTERM");
    const result = await resultPromise;

    assertExitCode(def.expect, result.exitCode, stdout, stderr);
    assertOutput(def.expect, stdout, stderr);
}

// ── Assertions ───────────────────────────────────────────────────────────────

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
