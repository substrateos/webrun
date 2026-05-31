// shared_registry.test.ts — Unit tests for SharedRegistry.
//
// Tests the deduplication registry: acquire, register, auto-eviction,
// concurrent pending state, and crash recovery.

import { SharedRegistry } from "./shared_registry.ts";

// ── Mock handle factory ──────────────────────────────────────────────────────

function mockHandle(opts?: { settled?: number }): { handle: any; settle: (code: number) => void } {
    let resolveExitCode!: (code: number) => void;
    const exitCode = new Promise<number>(r => { resolveExitCode = r; });
    const handle = {
        exitCode,
        urls: Promise.resolve([new URL("http://127.0.0.1:8000")]),
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        signal() {},
    };
    const settle = (code: number) => resolveExitCode(code);
    if (opts?.settled !== undefined) {
        resolveExitCode(opts.settled);
    }
    return { handle, settle };
}

// ── Test cases ───────────────────────────────────────────────────────────────

export async function testSharedRegistry(t: any) {
    await t.run("acquire unknown → null", () => {
        const reg = new SharedRegistry();
        const result = reg.acquire("unknown");
        if (result !== null) {
            throw new Error(`Expected null, got ${result}`);
        }
    });

    await t.run("register then acquire returns same handle", async () => {
        const reg = new SharedRegistry();
        const { handle } = mockHandle();
        reg.register("x", handle);
        const acquired = reg.acquire("x");
        if (acquired !== handle) {
            throw new Error("Acquired handle is not the same reference");
        }
    });

    await t.run("second register same key rejected", () => {
        const reg = new SharedRegistry();
        const { handle: h1 } = mockHandle();
        const { handle: h2 } = mockHandle();
        reg.register("x", h1);
        let threw = false;
        try {
            reg.register("x", h2);
        } catch {
            threw = true;
        }
        if (!threw) {
            throw new Error("Expected second register to throw");
        }
    });

    await t.run("settled handle auto-evicts", async () => {
        const reg = new SharedRegistry();
        const { handle, settle } = mockHandle();
        reg.register("x", handle);

        // Settle the exit code.
        settle(0);
        await handle.exitCode;

        // Allow microtask for cleanup callback.
        await new Promise(r => setTimeout(r, 0));

        const acquired = reg.acquire("x");
        if (acquired !== null) {
            throw new Error("Expected null after settlement, got handle");
        }
    });

    await t.run("different keys independent", () => {
        const reg = new SharedRegistry();
        const { handle: hx } = mockHandle();
        const { handle: hy } = mockHandle();
        reg.register("x", hx);
        reg.register("y", hy);
        if (reg.acquire("x") !== hx) throw new Error("x returned wrong handle");
        if (reg.acquire("y") !== hy) throw new Error("y returned wrong handle");
    });

    await t.run("concurrent acquire returns same handle", () => {
        const reg = new SharedRegistry();
        const { handle } = mockHandle();
        reg.register("x", handle);

        // Two acquires before settlement — both get same handle.
        const a = reg.acquire("x");
        const b = reg.acquire("x");
        if (a !== b) throw new Error("Concurrent acquires returned different handles");
        if (a !== handle) throw new Error("Acquired handle is not the registered one");
    });

    await t.run("crash → re-spawn: settled with non-zero evicts", async () => {
        const reg = new SharedRegistry();
        const { handle, settle } = mockHandle();
        reg.register("x", handle);

        // Crash.
        settle(1);
        await handle.exitCode;
        await new Promise(r => setTimeout(r, 0));

        // Now acquirable is null — ready for fresh spawn.
        const acquired = reg.acquire("x");
        if (acquired !== null) {
            throw new Error("Expected null after crash, got handle");
        }

        // Can register a new handle.
        const { handle: h2 } = mockHandle();
        reg.register("x", h2);
        if (reg.acquire("x") !== h2) {
            throw new Error("Re-registered handle not returned");
        }
    });
}
