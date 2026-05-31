// deno.ts — Deno-native test adapter.
//
// Bridges test*-prefixed exports from test modules to Deno.test().
// Provides a unified `ctx` with { Deno, WEBRUN_BIN, integrationDir, ... }.

import createFS from "../file_system/mod.ts";
import type { FSRuntime } from "../../core/file_system/types.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import { dirname } from "https://deno.land/std@0.224.0/path/dirname.ts";

const TESTS_DIR = join(dirname(new URL(import.meta.url).pathname), "../");

// Deno satisfies FSRuntime — the shim just narrows the stat return type.
const fs = createFS(globalThis.Deno as unknown as FSRuntime);

const integrationDir = new fs.FileSystemDirectoryHandle(
    join(TESTS_DIR, "../../integration"), "integration"
);

/** Test context passed to all test functions as the second argument. */
const ctx = {
    WEBRUN_BIN: Deno.env.get("WEBRUN_BIN") || join(TESTS_DIR, "../../webrun"),
    /** Deno runtime — tests destructure as `{ Deno }`. */
    Deno: globalThis.Deno,
    /** Deno.Command for spawning subprocesses. */
    Command: Deno.Command,
    /** Root DirHandle for integration test fixtures. */
    integrationDir,
    /** Resolve a DirHandle to its underlying string path. */
    resolveHandle: fs.resolveHandle,
    /** Create a new temp directory as a DirHandle. */
    makeTempDir(prefix = "case_") {
        const path = Deno.realPathSync(Deno.makeTempDirSync({ prefix }));
        return new fs.FileSystemDirectoryHandle(path, "tmp");
    },
    /** Remove a path synchronously. */
    removeSync: Deno.removeSync.bind(Deno),
};

export type TestCtx = typeof ctx;

/**
 * Bridges test*-prefixed exports to Deno.test() with a TestContext shim.
 */
export function registerTests(suiteName: string, exports: Record<string, unknown>): void {
    for (const [name, fn] of Object.entries(exports)) {
        if (!name.startsWith("test") || typeof fn !== "function") continue;
        const displayName = name.slice("test".length);
        Deno.test(`${suiteName}: ${displayName}`, async (rootCtx) => {
            function createShim(denoCtx: Deno.TestContext, currentName: string): any {
                return {
                    name: currentName,
                    run: async (stepName: string, stepFn: (t: any, ctx: any) => Promise<void>) => {
                        await denoCtx.step(stepName, async (innerCtx) => {
                            try {
                                await stepFn(createShim(innerCtx, stepName), ctx);
                            } catch (err: any) {
                                if (err?.name === "HarnessSkipError") {
                                    console.log(`[SKIPPED] ${stepName}: ${err.message || ""}`);
                                    return;
                                }
                                throw err;
                            }
                        });
                    },
                    assert: (condition: any, message?: string) => {
                        if (!condition) throw new Error(message || "Assertion failed");
                    },
                    fail: (message?: string) => {
                        throw new Error(message || "Test failed");
                    },
                    skip: (reason?: string): never => {
                        const err = new Error(reason);
                        err.name = "HarnessSkipError";
                        throw err;
                    },
                    log: (...args: any[]) => console.log(...args),
                };
            }

            try {
                await (fn as any)(createShim(rootCtx, displayName), ctx, Deno);
            } catch (err: any) {
                if (err?.name === "HarnessSkipError") {
                    console.log(`[SKIPPED] ${displayName}: ${err.message || ""}`);
                    return;
                }
                throw err;
            }
        });
    }
}
