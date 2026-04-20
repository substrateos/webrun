// _adapter.ts — Shim that bridges Deno.test ↔ our TestContext protocol.
//
// External tests use the same TestContext interface as sandbox tests,
// but run under raw Deno.test instead of webrun's sandbox harness.
//
// Usage:
//   import { denoTest } from "./_adapter.ts";
//   import { testMyThing } from "../my.test.ts";
//   denoTest("MyThing", testMyThing);

import type { TestContext } from "../../src/test_harness.ts";

class SkipSignal {
    constructor(readonly message: string) {}
}

function shimCtx(denoT: Deno.TestContext): TestContext {
    return {
        get name() { return denoT.name; },

        async run(name: string, fn: (t: TestContext) => Promise<void>): Promise<void> {
            await denoT.step(name, async (subT: Deno.TestContext) => {
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

const denoTestOpts = {
    sanitizeOps: false,
    sanitizeResources: false,
    sanitizeExit: false,
} as const;

/**
 * Register a TestContext-shaped function as a Deno.test.
 */
export function denoTest(
    name: string,
    fn: (t: TestContext) => Promise<void>,
): void {
    Deno.test({ name, ...denoTestOpts }, (t) => fn(shimCtx(t)));
}
