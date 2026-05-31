// meta.test.ts — Unit tests for import map resolution (ctx.meta.resolve).
//
// Tests the WHATWG import map resolution algorithm:
// - Relative specifiers resolve against base URL
// - Absolute URLs pass through unchanged
// - Bare specifiers match exact entries in imports
// - Package prefix matching (trailing-slash keys)
// - Scoped resolution (scope-specific imports)
// - Scope specificity (most-specific scope wins)

import { resolveSpecifier } from "./meta.ts";
import type { ImportMap } from "./types.ts";

interface ResolveCase {
    name: string;
    specifier: string;
    baseUrl: string;
    importMap?: ImportMap;
    expected: string;
}

const cases: ResolveCase[] = [
    // ── Relative specifiers ──────────────────────────────────────────────
    {
        name: "relative ./ resolves against base URL",
        specifier: "./greeting.ts",
        baseUrl: "file:///project/sub/suite.test.html",
        expected: "file:///project/sub/greeting.ts",
    },
    {
        name: "relative ../ resolves against base URL",
        specifier: "../utils.ts",
        baseUrl: "file:///project/sub/suite.test.html",
        expected: "file:///project/utils.ts",
    },
    {
        name: "relative deeply nested ../ resolves correctly",
        specifier: "../../lib/core.ts",
        baseUrl: "file:///project/src/sub/main.ts",
        expected: "file:///project/lib/core.ts",
    },

    // ── Absolute URLs ────────────────────────────────────────────────────
    {
        name: "absolute file:// URL passes through",
        specifier: "file:///other/module.ts",
        baseUrl: "file:///project/main.ts",
        expected: "file:///other/module.ts",
    },
    {
        name: "absolute https:// URL passes through",
        specifier: "https://cdn.example.com/lib.js",
        baseUrl: "file:///project/main.ts",
        expected: "https://cdn.example.com/lib.js",
    },

    // ── Bare specifier exact match ────────────────────────────────────────
    {
        name: "bare specifier exact match in imports",
        specifier: "greeting",
        baseUrl: "file:///project/sub/suite.test.html",
        importMap: {
            imports: { "greeting": "file:///project/greeting.ts" },
        },
        expected: "file:///project/greeting.ts",
    },
    {
        name: "bare specifier not in imports resolves as relative (URL constructor)",
        specifier: "unknown-module",
        baseUrl: "file:///project/main.ts",
        importMap: { imports: {} },
        expected: "file:///project/unknown-module",
    },

    // ── Package prefix matching (trailing-slash) ─────────────────────────
    {
        name: "package prefix match with trailing slash",
        specifier: "lodash/fp/map",
        baseUrl: "file:///project/main.ts",
        importMap: {
            imports: { "lodash/": "file:///vendor/lodash/" },
        },
        expected: "file:///vendor/lodash/fp/map",
    },
    {
        name: "exact match takes priority over prefix match",
        specifier: "lodash/fp",
        baseUrl: "file:///project/main.ts",
        importMap: {
            imports: {
                "lodash/fp": "file:///vendor/lodash-fp-bundle.js",
                "lodash/": "file:///vendor/lodash/",
            },
        },
        expected: "file:///vendor/lodash-fp-bundle.js",
    },

    // ── Scoped resolution ────────────────────────────────────────────────
    {
        name: "scope-specific imports override top-level imports",
        specifier: "greeting",
        baseUrl: "file:///project/sub/suite.test.html",
        importMap: {
            imports: { "greeting": "file:///project/greeting-v1.ts" },
            scopes: {
                "file:///project/sub/": {
                    "greeting": "file:///project/greeting-v2.ts",
                },
            },
        },
        expected: "file:///project/greeting-v2.ts",
    },
    {
        name: "scope does not match when base URL is outside scope",
        specifier: "greeting",
        baseUrl: "file:///project/other/main.ts",
        importMap: {
            imports: { "greeting": "file:///project/greeting-v1.ts" },
            scopes: {
                "file:///project/sub/": {
                    "greeting": "file:///project/greeting-v2.ts",
                },
            },
        },
        expected: "file:///project/greeting-v1.ts",
    },
    {
        name: "most-specific scope wins when multiple scopes match",
        specifier: "util",
        baseUrl: "file:///project/src/deep/main.ts",
        importMap: {
            imports: { "util": "file:///global/util.ts" },
            scopes: {
                "file:///project/": { "util": "file:///project/util.ts" },
                "file:///project/src/": { "util": "file:///project/src/util.ts" },
                "file:///project/src/deep/": { "util": "file:///project/src/deep/util.ts" },
            },
        },
        expected: "file:///project/src/deep/util.ts",
    },

    // ── Scoped prefix matching ───────────────────────────────────────────
    {
        name: "scope with package prefix matching",
        specifier: "lib/helper",
        baseUrl: "file:///app/src/main.ts",
        importMap: {
            imports: { "lib/": "file:///global/lib/" },
            scopes: {
                "file:///app/": { "lib/": "file:///app/vendor/lib/" },
            },
        },
        expected: "file:///app/vendor/lib/helper",
    },

    // ── No import map ────────────────────────────────────────────────────
    {
        name: "no import map — relative resolves normally",
        specifier: "./foo.ts",
        baseUrl: "file:///project/main.ts",
        expected: "file:///project/foo.ts",
    },

    // ── Import map value that is relative ────────────────────────────────
    {
        name: "import map value that is relative resolves against base URL",
        specifier: "greeting",
        baseUrl: "file:///project/sub/main.ts",
        importMap: {
            imports: { "greeting": "../greeting.ts" },
        },
        expected: "file:///project/greeting.ts",
    },
];

export function testResolveSpecifier(t: any) {
    for (const c of cases) {
        const result = resolveSpecifier(c.specifier, c.baseUrl, c.importMap);
        if (result !== c.expected) {
            throw new Error(`[${c.name}] Expected ${c.expected}, got ${result}`);
        }
    }
}
