// run_arg.test.ts — Unit tests for RunArg template tag.
//
// Tests the ctx.run.arg tagged template literal: handle detection,
// URL resolution, grant collection, and plain value passthrough.

import { createRunArgTag, isRunArg, extractGrants } from "./run_arg.ts";

// ── Mock handles ─────────────────────────────────────────────────────

function mockDirHandle(name: string): any {
    return { kind: "directory", name };
}

function mockFileHandle(name: string): any {
    return { kind: "file", name };
}

function mockResolve(handle: any): string {
    return `file:///mock/${handle.name}`;
}

// ── Tag behavior ─────────────────────────────────────────────────────

interface TagCase {
    name: string;
    build: (arg: any) => any;
    expectedValue: string;
    expectedGrantCount: number;
}

const tagCases: TagCase[] = [
    {
        name: "bare handle interpolation",
        build: (arg) => arg`${mockDirHandle("src")}`,
        expectedValue: "file:///mock/src",
        expectedGrantCount: 1,
    },
    {
        name: "handle with flag prefix",
        build: (arg) => arg`--dir=${mockDirHandle("project")}`,
        expectedValue: "--dir=file:///mock/project",
        expectedGrantCount: 1,
    },
    {
        name: "file handle",
        build: (arg) => arg`${mockFileHandle("main.ts")}`,
        expectedValue: "file:///mock/main.ts",
        expectedGrantCount: 1,
    },
    {
        name: "plain string — no grants",
        build: (arg) => arg`--flag=${"value"}`,
        expectedValue: "--flag=value",
        expectedGrantCount: 0,
    },
    {
        name: "number — no grants",
        build: (arg) => arg`--count=${42}`,
        expectedValue: "--count=42",
        expectedGrantCount: 0,
    },
    {
        name: "mixed handle and plain",
        build: (arg) => arg`--src=${mockDirHandle("lib")} --name=${"foo"}`,
        expectedValue: "--src=file:///mock/lib --name=foo",
        expectedGrantCount: 1,
    },
    {
        name: "multiple handles",
        build: (arg) => arg`${mockDirHandle("a")}:${mockFileHandle("b.ts")}`,
        expectedValue: "file:///mock/a:file:///mock/b.ts",
        expectedGrantCount: 2,
    },
    {
        name: "static string — no interpolation",
        build: (arg) => arg`--verbose`,
        expectedValue: "--verbose",
        expectedGrantCount: 0,
    },
];

export function testRunArgTag(t: any) {
    const arg = createRunArgTag(mockResolve);

    for (const c of tagCases) {
        const result = c.build(arg);
        if (!isRunArg(result)) {
            throw new Error(`[${c.name}] Expected RunArg, got ${typeof result}`);
        }
        if (result.value !== c.expectedValue) {
            throw new Error(`[${c.name}] value: expected "${c.expectedValue}", got "${result.value}"`);
        }
        if (result.grants.length !== c.expectedGrantCount) {
            throw new Error(`[${c.name}] grants: expected ${c.expectedGrantCount}, got ${result.grants.length}`);
        }
    }
}

// ── isRunArg discrimination ──────────────────────────────────────────

const discriminationCases: Array<{ name: string; value: any; expected: boolean }> = [
    { name: "RunArg is identified", value: "USE_TAG", expected: true },
    { name: "plain string rejected", value: "hello", expected: false },
    { name: "number rejected", value: 42, expected: false },
    { name: "null rejected", value: null, expected: false },
    { name: "undefined rejected", value: undefined, expected: false },
    { name: "plain object rejected", value: { value: "x", grants: [] }, expected: false },
];

export function testIsRunArg(t: any) {
    const arg = createRunArgTag(mockResolve);

    for (const c of discriminationCases) {
        const input = c.value === "USE_TAG" ? arg`${mockDirHandle("x")}` : c.value;
        const result = isRunArg(input);
        if (result !== c.expected) {
            throw new Error(`[${c.name}] expected isRunArg=${c.expected}, got ${result}`);
        }
    }
}

// ── extractGrants ────────────────────────────────────────────────────

export function testExtractGrants(t: any) {
    const arg = createRunArgTag(mockResolve);

    // Mixed args: some RunArg, some plain strings.
    const args = [
        "--test",
        arg`${mockDirHandle("src")}`,
        arg`--out=${mockDirHandle("dist")}`,
        "--verbose",
    ];

    const grants = extractGrants(args);

    // Should extract 2 grants from the 2 RunArgs.
    if (grants.length !== 2) {
        throw new Error(`Expected 2 grants, got ${grants.length}`);
    }

    // Grants carry resolved URLs, not raw handles.
    if (grants[0].resolvedUrl !== "file:///mock/src") {
        throw new Error(`Expected first grant "file:///mock/src", got "${grants[0].resolvedUrl}"`);
    }
    if (grants[1].resolvedUrl !== "file:///mock/dist") {
        throw new Error(`Expected second grant "file:///mock/dist", got "${grants[1].resolvedUrl}"`);
    }
}

// ── args stringification ─────────────────────────────────────────────

export function testStringifyArgs(t: any) {
    const arg = createRunArgTag(mockResolve);

    const args = [
        "--test",
        arg`${mockDirHandle("src")}`,
        "--verbose",
    ];

    // When passed to ctx.run(), RunArgs should be stringified.
    const strings = args.map(a => isRunArg(a) ? a.value : String(a));
    if (strings[0] !== "--test") throw new Error(`[0] expected "--test", got "${strings[0]}"`);
    if (strings[1] !== "file:///mock/src") throw new Error(`[1] expected "file:///mock/src", got "${strings[1]}"`);
    if (strings[2] !== "--verbose") throw new Error(`[2] expected "--verbose", got "${strings[2]}"`);
}
