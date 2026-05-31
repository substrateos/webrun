// shared.test.ts — Unit tests for shared run validation and identity.
//
// Tests validateSharedOptions (rejects all RunOptions fields when shared: true)
// and sharedKey (stable, path-unique identity).

import { validateSharedOptions, sharedKey } from "./shared.ts";

// ── Validation: shared rejects all option fields ─────────────────────────────

interface ValidationCase {
    name: string;
    args: string[];
    options: Record<string, unknown>;
    expectError: boolean;
}

const validationCases: ValidationCase[] = [
    // Rejection cases: shared + any option field → TypeError
    // Note: args here are parsed guest args (post-parsing), not raw CLI args.
    { name: "shared + extra args", args: ["--port=3000"], options: { shared: true }, expectError: true },
    { name: "shared + env", args: [], options: { shared: true, env: { K: "v" } }, expectError: true },
    { name: "shared + stdin", args: [], options: { shared: true, stdin: new ReadableStream() }, expectError: true },
    { name: "shared + signal", args: [], options: { shared: true, signal: new AbortController().signal }, expectError: true },
    { name: "shared + permissions", args: [], options: { shared: true, permissions: { network: ["*"] } }, expectError: true },
    { name: "shared + limits", args: [], options: { shared: true, limits: { timeoutMillis: 1000 } }, expectError: true },
    { name: "shared + dir", args: [], options: { shared: true, dir: {} }, expectError: true },
    { name: "shared + storage", args: [], options: { shared: true, storage: [] }, expectError: true },
    { name: "shared + mode", args: [], options: { shared: true, mode: "binary" }, expectError: true },
    { name: "shared + serve", args: [], options: { shared: true, serve: ["http://127.0.0.1:0"] }, expectError: true },
    { name: "shared + importMap", args: [], options: { shared: true, importMap: { imports: {} } }, expectError: true },

    // Acceptance cases
    { name: "shared + no guest args", args: [], options: { shared: true }, expectError: false },
    { name: "non-shared passthrough", args: ["--flag"], options: { env: { X: "1" } }, expectError: false },
    { name: "empty options", args: [], options: {}, expectError: false },
];

export async function testValidateSharedOptions(t: any) {
    for (const c of validationCases) {
        await t.run(c.name, () => {
            let threw = false;
            let errorType = "";
            try {
                validateSharedOptions(c.args, c.options);
            } catch (e: any) {
                threw = true;
                errorType = e?.constructor?.name || "unknown";
            }
            if (c.expectError && !threw) {
                throw new Error(`Expected TypeError, but no error was thrown`);
            }
            if (c.expectError && errorType !== "TypeError") {
                throw new Error(`Expected TypeError, got ${errorType}`);
            }
            if (!c.expectError && threw) {
                throw new Error(`Expected no error, but ${errorType} was thrown`);
            }
        });
    }
}

// ── Identity: sharedKey ──────────────────────────────────────────────────────

interface KeyCase {
    name: string;
    pathA: string;
    pathB: string;
    expectSame: boolean;
}

const keyCases: KeyCase[] = [
    { name: "same path → same key", pathA: "/abs/server.ts", pathB: "/abs/server.ts", expectSame: true },
    { name: "different paths → different keys", pathA: "/a/server.ts", pathB: "/b/server.ts", expectSame: false },
];

export async function testSharedKey(t: any) {
    for (const c of keyCases) {
        await t.run(c.name, () => {
            const keyA = sharedKey(c.pathA);
            const keyB = sharedKey(c.pathB);
            if (c.expectSame && keyA !== keyB) {
                throw new Error(`Expected same key, got "${keyA}" vs "${keyB}"`);
            }
            if (!c.expectSame && keyA === keyB) {
                throw new Error(`Expected different keys, got "${keyA}" for both`);
            }
        });
    }
}
