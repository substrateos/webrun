// _adapter.ts — External test entry point.
//
// 1. Creates the concrete sys object for the host environment.
// 2. Bridges the host test runner ↔ our TestContext protocol.
// 3. Registers test*-prefixed exports as test suites.

import type { TestExternalRuntime } from "../../src/types.ts";
import type { TestContext } from "../../src/test_harness.ts";

// ── Sys binding ──────────────────────────────────────────────────────────────

const d = globalThis.Deno;

export const sys: TestExternalRuntime = {
    readDirSync: d.readDirSync,
    readTextFileSync: d.readTextFileSync,
    readFileSync: d.readFileSync,
    writeTextFileSync: d.writeTextFileSync,
    writeFileSync: d.writeFileSync,
    copyFileSync: d.copyFileSync,
    mkdirSync: d.mkdirSync,
    removeSync: d.removeSync,
    makeTempDirSync: d.makeTempDirSync,
    realPathSync: d.realPathSync,
    statSync: d.statSync,
    Command: d.Command,
    execPath: d.execPath.bind(d),
    listen: d.listen.bind(d),
    serve: d.serve.bind(d),
    test: d.test,
    env: d.env,
};

// ── TestContext shim ─────────────────────────────────────────────────────────

class SkipSignal {
    constructor(readonly message: string) {}
}

function shimCtx(hostT: { name: string; step: Function }): TestContext {
    return {
        get name() { return hostT.name; },

        async run(name: string, fn: (t: TestContext) => Promise<void>): Promise<void> {
            await hostT.step(name, async (subT: any) => {
                try {
                    await fn(shimCtx(subT));
                } catch (err) {
                    if (err instanceof SkipSignal) return;
                    throw err;
                }
            });
        },

        assert(condition: any, message?: string): void {
            if (!condition) throw new Error(message ?? "Assertion failed");
        },

        fail(message?: string): void {
            throw new Error(message ?? "Test failed explicitly");
        },

        skip(message?: string): never {
            throw new SkipSignal(message ?? "Skipped");
        },

        log(...args: unknown[]): void {
            console.log(...args.map(a => (typeof a === "string" ? a : JSON.stringify(a))));
        },
    };
}

const testOpts = {
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
} as const;

/**
 * Register all `test*`-prefixed functions as host test suites.
 *
 * Follows the same naming convention as the sandbox test harness:
 * `testFoo` → test suite named `"Foo"`.
 */
export function registerTests(exports: Record<string, unknown>): void {
    for (const [name, fn] of Object.entries(exports)) {
        if (!name.startsWith("test") || typeof fn !== "function") continue;
        const displayName = name.slice("test".length);
        sys.test({ name: displayName, ...testOpts }, (t) => (fn as any)(shimCtx(t)));
    }
}
