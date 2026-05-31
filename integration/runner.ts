// runner.ts — Shared runner utilities: assertions, FSDH helpers, HTTP probes.

import type { CaseExpect, HttpProbe, WsProbe, DirHandle } from "./suite.ts";

// ── FSDH Helpers ─────────────────────────────────────────────────────────────

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

/** Navigate to a subdirectory handle by walking path segments. */
export async function subdir(parent: DirHandle, path: string): Promise<DirHandle> {
    let current = parent;
    for (const segment of path.split("/").filter(Boolean)) {
        current = await current.getDirectoryHandle(segment);
    }
    return current;
}

// ── Assertions ───────────────────────────────────────────────────────────────

export function assertExitCode(expect: CaseExpect, code: number, stdout: string, stderr: string) {
    if (expect.exit_code === "nonzero") {
        if (code === 0) throw new Error(`Expected nonzero exit code, got 0\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    } else {
        if (code !== expect.exit_code) throw new Error(`Expected exit code ${expect.exit_code}, got ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    }
}

export function assertOutput(expect: CaseExpect, stdout: string, stderr: string) {
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

// ── HTTP Probes ──────────────────────────────────────────────────────────────

/** Extract the port from a "serving at http://...:PORT" stdout line. */
export function extractPort(stdout: string): number | undefined {
    const m = stdout.match(/serving at https?:\/\/[^:]+:(\d+)/);
    return m ? parseInt(m[1], 10) : undefined;
}

/** Run HTTP probes against a local server. */
export async function runHttpProbes(port: number, probes: HttpProbe[]): Promise<void> {
    for (const probe of probes) {
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

// ── WebSocket Probes ─────────────────────────────────────────────────────────

/** Run WebSocket probes against a local server. */
export async function runWsProbes(port: number, probes: WsProbe[]): Promise<void> {
    for (const probe of probes) {
        const timeout = probe.timeout_ms ?? 5000;
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`WebSocket probe timed out after ${timeout}ms`)), timeout);
            const ws = new WebSocket(`ws://127.0.0.1:${port}${probe.path}`);
            ws.onopen = () => ws.send(probe.send);
            ws.onmessage = (e) => {
                clearTimeout(timer);
                if (e.data === probe.expect_reply) {
                    ws.close();
                    resolve();
                } else {
                    ws.close();
                    reject(new Error(`WS ${probe.path}: expected "${probe.expect_reply}", got "${e.data}"`));
                }
            };
            ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`WS error on ${probe.path}: ${e}`)); };
        });
    }
}
