// _cli_runner.ts — Shared case runner for external CLI-based test suites.
//
// Discovers cases.json files, copies fixtures to temp dirs, spawns the
// webrun binary as a real subprocess, and asserts exit codes and output.
//
// Used by suites that need the full host pipeline: import maps, type checking,
// OS-level sandbox enforcement, serve mode, and policy tests.

import { sys } from "./_adapter.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

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
    runner?: "cli" | "cli-signal";
    expect: CaseExpect;
}

export const WEBRUN_BIN = sys.env.get("WEBRUN_BIN") ||
    join(dirname(new URL(import.meta.url).pathname), "../../webrun");

export function discoverCases(rootDir: string): { dir: string; def: CaseDefinition }[] {
    const cases: { dir: string; def: CaseDefinition }[] = [];
    let entries: Iterable<{ name: string; isDirectory: boolean }>;
    try { entries = sys.readDirSync(rootDir); } catch { return cases; }
    for (const entry of entries) {
        if (!entry.isDirectory) continue;
        const caseDir = join(rootDir, entry.name);
        try {
            const raw = sys.readTextFileSync(join(caseDir, "cases.json"));
            const defs: CaseDefinition[] = JSON.parse(raw);
            for (const def of defs) cases.push({ dir: caseDir, def });
        } catch {
            cases.push(...discoverCases(caseDir));
        }
    }
    return cases;
}

export function copyDirRecursive(src: string, dest: string): void {
    sys.mkdirSync(dest, { recursive: true });
    for (const entry of sys.readDirSync(src)) {
        const s = join(src, entry.name);
        const d = join(dest, entry.name);
        if (entry.isDirectory) {
            copyDirRecursive(s, d);
        } else {
            sys.copyFileSync(s, d);
        }
    }
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

/** Spawn webrun binary, wait for exit, assert exit code and output. */
export async function runCliCase(caseDir: string, def: CaseDefinition): Promise<void> {
    const runDir = sys.realPathSync(sys.makeTempDirSync({ prefix: "case_" }));
    copyDirRecursive(caseDir, runDir);

    const cwd = def.cwd ? join(runDir, def.cwd) : runDir;
    const args = def.args || ["main.ts"];

    const cmd = new sys.Command(WEBRUN_BIN, {
        args,
        cwd,
        env: { ...def.env },
        stdout: "piped",
        stderr: "piped"
    });

    const out = await cmd.output();
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);

    try { sys.removeSync(runDir, { recursive: true }); } catch (_) {}

    assertExitCode(def.expect, out.code, stdout, stderr);
    assertOutput(def.expect, stdout, stderr);
}

/** Spawn webrun binary with streaming output, ready conditions, HTTP probes, and signal lifecycle. */
export async function runCliSignalCase(caseDir: string, def: CaseDefinition): Promise<void> {
    const runDir = sys.realPathSync(sys.makeTempDirSync({ prefix: "case_" }));
    copyDirRecursive(caseDir, runDir);

    const cwd = def.cwd ? join(runDir, def.cwd) : runDir;
    const args = def.args || ["--serve", "."];
    const deadline = def.timeout_ms ?? 10_000;

    const child = new sys.Command(WEBRUN_BIN, {
        args,
        cwd,
        env: { ...def.env },
        stdout: "piped",
        stderr: "piped",
        stdin: "null",
    }).spawn();

    let stdout = "", stderr = "";
    let onChunk: (() => void) | null = null;

    const decoder = new TextDecoder();
    const readStream = async (reader: any, target: "stdout" | "stderr") => {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                if (target === "stdout") stdout += chunk;
                else stderr += chunk;
                if (onChunk) onChunk();
            }
        } catch (_) {}
    };

    const stdoutDone = readStream(child.stdout.getReader(), "stdout");
    const stderrDone = readStream(child.stderr.getReader(), "stderr");

    // Wait for ready condition.
    if (def.expect.ready) {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                try { child.kill("SIGKILL"); } catch (_) {}
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

    // Signal the process.
    const sig = def.signal || "SIGTERM";
    try { child.kill(sig as any); } catch (_) {}
    const status = await child.status;
    await Promise.all([stdoutDone, stderrDone]);

    try { sys.removeSync(runDir, { recursive: true }); } catch (_) {}

    assertExitCode(def.expect, status.code, stdout, stderr);
    assertOutput(def.expect, stdout, stderr);
}
