// html_test.test.ts — Table-driven unit tests for src/host/html_test.ts.
//
// Strategy: parseHtmlScripts and parseHtmlImportMap are pure functions.
// We test them with declarative tables covering script extraction,
// enabled-attribute filtering, importmap parsing, and base URL resolution.

import { parseHtmlScripts, parseHtmlImportMap } from "../src/host/html_test.ts";

// =========================================================
// CATEGORY 1: Script Extraction
// =========================================================

const scriptExtractionCases: Array<{
    name: string;
    html: string;
    expectedCount: number;
    expectedContents?: string[];
    expectedSkip?: boolean[];
}> = [
    {
        name: "single module script with no skip attribute",
        html: `<script type="module">export function testFoo() {}</script>`,
        expectedCount: 1,
        expectedContents: [`export function testFoo() {}`],
        expectedSkip: [false],
    },
    {
        name: "multiple module scripts extracted in order",
        html: `
            <script type="module">export function testA() {}</script>
            <script type="module">export function testB() {}</script>
        `,
        expectedCount: 2,
        expectedContents: [`export function testA() {}`, `export function testB() {}`],
    },
    {
        name: "webrun-skip attribute is parsed",
        html: `<script type="module" webrun-skip>export function testX() {}</script>`,
        expectedCount: 1,
        expectedSkip: [true],
    },
    {
        name: "webrun-skip works with arbitrary values",
        html: `<script type="module" webrun-skip="true">console.log("browser")</script>`,
        expectedCount: 1,
        expectedSkip: [true],
    },
    {
        name: "importmap scripts are NOT extracted as module scripts",
        html: `
            <script type="importmap">{"imports":{}}</script>
            <script type="module">export function testZ() {}</script>
        `,
        expectedCount: 1,
        expectedContents: [`export function testZ() {}`],
    },
    {
        name: "standard script types are extracted",
        html: `
            <script>var x = 1;</script>
            <script type="text/javascript">var y = 2;</script>
            <script type="application/javascript">var z = 3;</script>
            <script type="module">export function testOnly() {}</script>
        `,
        expectedCount: 4,
        expectedContents: [`var x = 1;`, `var y = 2;`, `var z = 3;`, `export function testOnly() {}`],
        expectedSkip: [false, false, false, false],
    },
    {
        name: "module+webrun script type is extracted",
        html: `<script type="module+webrun">console.log("webrun-only")</script>`,
        expectedCount: 1,
        expectedContents: [`console.log("webrun-only")`],
        expectedSkip: [false],
    },
    {
        name: "non-executable script types are ignored to prevent over-execution",
        html: `
            <script type="text/html"><div>Hello</div></script>
            <script type="text/template">Template</script>
            <script type="application/json">{"data":1}</script>
            <script type="module">export function testA() {}</script>
        `,
        expectedCount: 1,
        expectedContents: [`export function testA() {}`],
        expectedSkip: [false],
    },
    {
        name: "empty HTML returns zero scripts",
        html: `<!DOCTYPE html><html><body></body></html>`,
        expectedCount: 0,
    },
    {
        name: "script with src attribute is extracted",
        html: `<script type="module" src="./app.ts"></script>`,
        expectedCount: 1,
        expectedContents: [undefined as any],
        expectedSkip: [false],
    },
    {
        name: "multiline script content preserved",
        html: `<script type="module">
import { foo } from "./foo.ts";
export function testMultiline() {
    foo();
}
</script>`,
        expectedCount: 1,
        expectedContents: [`import { foo } from "./foo.ts";\nexport function testMultiline() {\n    foo();\n}`],
    },
];

export async function testHtmlScriptExtraction(t: any) {
    for (const tc of scriptExtractionCases) {
        await t.run(tc.name, async () => {
            const scripts = parseHtmlScripts(tc.html);
            if (scripts.length !== tc.expectedCount) {
                throw new Error(`Expected ${tc.expectedCount} scripts, got ${scripts.length}: ${JSON.stringify(scripts)}`);
            }
            if (tc.expectedContents) {
                for (let i = 0; i < tc.expectedContents.length; i++) {
                    const script = scripts[i];
                    if (tc.expectedContents[i] === undefined) {
                        if (script.content !== undefined) {
                            throw new Error(`Script ${i}: expected undefined content, got "${script.content}"`);
                        }
                    } else {
                        const actual = script.content ? script.content.trim() : undefined;
                        const expected = tc.expectedContents[i].trim();
                        if (actual !== expected) {
                            throw new Error(`Script ${i}: expected content "${expected}", got "${actual}"`);
                        }
                    }
                }
            }
            if (tc.expectedSkip) {
                for (let i = 0; i < tc.expectedSkip.length; i++) {
                    if (scripts[i].skip !== tc.expectedSkip[i]) {
                        throw new Error(`Script ${i}: expected skip="${tc.expectedSkip[i]}", got "${scripts[i].skip}"`);
                    }
                }
            }
        });
    }
}

// =========================================================
// CATEGORY 2: Import Map Extraction
// =========================================================

const importMapCases: Array<{
    name: string;
    html: string;
    expectedMap: any | null;
}> = [
    {
        name: "extracts inline importmap",
        html: `<script type="importmap">{"imports":{"foo":"./foo.ts"}}</script>`,
        expectedMap: { imports: { foo: "./foo.ts" } },
    },
    {
        name: "returns null when no importmap present",
        html: `<script type="module">export function testA() {}</script>`,
        expectedMap: null,
    },
    {
        name: "extracts importmap with scopes",
        html: `<script type="importmap">{"imports":{"a":"./a.ts"},"scopes":{"./lib/":{"b":"./b.ts"}}}</script>`,
        expectedMap: { imports: { a: "./a.ts" }, scopes: { "./lib/": { b: "./b.ts" } } },
    },
    {
        name: "extracts importmap with data: URI values",
        html: `<script type="importmap">{"imports":{"my-mod":"data:text/javascript;base64,ZXhwb3J0IGRlZmF1bHQgNDI7"}}</script>`,
        expectedMap: { imports: { "my-mod": "data:text/javascript;base64,ZXhwb3J0IGRlZmF1bHQgNDI7" } },
    },
    {
        name: "only first importmap is used (spec behavior)",
        html: `
            <script type="importmap">{"imports":{"first":"./first.ts"}}</script>
            <script type="importmap">{"imports":{"second":"./second.ts"}}</script>
        `,
        expectedMap: { imports: { first: "./first.ts" } },
    },
    {
        name: "importmap with extra whitespace is parsed correctly",
        html: `<script   type="importmap"  >
            {
                "imports": {
                    "lib": "./lib.ts"
                }
            }
        </script>`,
        expectedMap: { imports: { lib: "./lib.ts" } },
    },
];

export async function testHtmlImportMapExtraction(t: any) {
    for (const tc of importMapCases) {
        await t.run(tc.name, async () => {
            const result = parseHtmlImportMap(tc.html);
            const expected = tc.expectedMap;
            if (expected === null) {
                if (result !== null) {
                    throw new Error(`Expected null, got ${JSON.stringify(result)}`);
                }
            } else {
                if (result === null) {
                    throw new Error(`Expected ${JSON.stringify(expected)}, got null`);
                }
                const resultStr = JSON.stringify(result);
                const expectedStr = JSON.stringify(expected);
                if (resultStr !== expectedStr) {
                    throw new Error(`Expected ${expectedStr}, got ${resultStr}`);
                }
            }
        });
    }
}

// =========================================================
// CATEGORY 3: Skip attribute filtering
// =========================================================

const skipFilterCases: Array<{
    name: string;
    html: string;
    expectedCount: number;
}> = [
    {
        name: "filtering removes webrun-skip scripts",
        html: `
            <script type="module">export function testA() {}</script>
            <script type="module" webrun-skip>console.log("nope")</script>
        `,
        expectedCount: 1,
    },
    {
        name: "scripts without skip attribute survive filtering",
        html: `
            <script type="module">export function testDefault() {}</script>
            <script type="module">console.log("yep")</script>
        `,
        expectedCount: 2,
    },
    {
        name: "empty skip attribute works",
        html: `
            <script type="module">export function testA() {}</script>
            <script type="module" webrun-skip="">export function testB() {}</script>
        `,
        expectedCount: 1,
    },
];

export async function testHtmlSkipFiltering(t: any) {
    for (const tc of skipFilterCases) {
        await t.run(tc.name, async () => {
            const scripts = parseHtmlScripts(tc.html);
            const filtered = scripts.filter(s => !s.skip);
            if (filtered.length !== tc.expectedCount) {
                throw new Error(`Expected ${tc.expectedCount} scripts after filtering skip, got ${filtered.length}`);
            }
        });
    }
}

// =========================================================
// CATEGORY 4: User-Agent for remote HTML fetch
// =========================================================

import { HTML_FETCH_USER_AGENT } from "../src/host/html_test.ts";

const userAgentCases: Array<{
    name: string;
    check: (ua: string) => boolean;
    message: string;
}> = [
    {
        name: "includes 'webrun' identifier",
        check: (ua) => ua.toLowerCase().includes("webrun"),
        message: "User-Agent must include 'webrun' for identification",
    },
    {
        name: "looks like a browser (contains Mozilla)",
        check: (ua) => ua.includes("Mozilla/5.0"),
        message: "User-Agent must start with browser-like prefix",
    },
    {
        name: "contains WebKit/Chrome markers for CDN compatibility",
        check: (ua) => ua.includes("AppleWebKit") && ua.includes("Chrome"),
        message: "User-Agent must include browser engine markers",
    },
    {
        name: "does not contain 'Deno'",
        check: (ua) => !ua.includes("Deno"),
        message: "User-Agent must not expose the Deno runtime identity",
    },
];

export async function testHtmlFetchUserAgent(t: any) {
    for (const tc of userAgentCases) {
        await t.run(tc.name, async () => {
            if (!tc.check(HTML_FETCH_USER_AGENT)) {
                throw new Error(`${tc.message}\nActual: "${HTML_FETCH_USER_AGENT}"`);
            }
        });
    }
}

// =========================================================
// CATEGORY 5: Network permission enforcement
// =========================================================

import { processHtmlTestTargets } from "../src/host/html_test.ts";

// Minimal mock sys for processHtmlTestTargets (only readTextFileSync is used for local files).
function mockHostSys(files: Record<string, string> = {}): any {
    return {
        readTextFileSync: (path: string) => {
            if (files[path] !== undefined) return files[path];
            throw new Error(`No such file: ${path}`);
        },
        writeTextFileSync: () => {},
        mkdirSync: () => {},
    };
}

const networkPermCases: Array<{
    name: string;
    target: string;
    allowedDomains: string[];
    shouldThrow: boolean;
    expectedErrorSubstring?: string;
}> = [
    {
        name: "blocks remote HTML when domain not in permissions.network",
        target: "https://evil.example.com/test.html",
        allowedDomains: ["trusted.example.com"],
        shouldThrow: true,
        expectedErrorSubstring: "Network permission denied",
    },
    {
        name: "blocks remote HTML when permissions.network is empty",
        target: "https://any-host.com/test.html",
        allowedDomains: [],
        shouldThrow: true,
        expectedErrorSubstring: "Network permission denied",
    },
    {
        name: "allows remote HTML when domain is explicitly listed",
        target: "https://trusted.example.com/test.html",
        allowedDomains: ["trusted.example.com"],
        shouldThrow: false,  // Will fail on fetch (no server), but won't throw permission error
    },
    {
        name: "allows remote HTML when wildcard * is in permissions.network",
        target: "https://anything.example.com/test.html",
        allowedDomains: ["*"],
        shouldThrow: false,  // Will fail on fetch, but won't throw permission error
    },
    {
        name: "local .html files bypass network check entirely",
        target: "/tmp/nonexistent/test.html",
        allowedDomains: [],
        shouldThrow: true,  // Throws because file doesn't exist, not because of network
        expectedErrorSubstring: "No such file",
    },
];

export async function testHtmlNetworkPermissions(t: any) {
    for (const tc of networkPermCases) {
        await t.run(tc.name, async () => {
            const sys = mockHostSys();
            const invocation: any = {
                action: "test",
                targetScriptPath: tc.target,
                additionalTargets: undefined,
                injectedArgsObj: { "--": [] },
                networkFlags: [],
                sandboxArgs: [],
            };
            const importMapPaths: string[] = [];

            try {
                await processHtmlTestTargets(sys, invocation, "/tmp/runner", importMapPaths, tc.allowedDomains);
                if (tc.shouldThrow) {
                    throw new Error(`Expected error for "${tc.name}" but none was thrown`);
                }
            } catch (err: any) {
                if (!tc.shouldThrow) {
                    // For "allows" cases with remote URLs, we expect fetch to fail
                    // (no real server), but the error should NOT be a permission error.
                    if (err.message.includes("Network permission denied")) {
                        throw new Error(`Unexpected network permission error for "${tc.name}": ${err.message}`);
                    }
                    // Other errors (fetch failure, etc.) are expected and acceptable.
                    return;
                }
                if (tc.expectedErrorSubstring && !err.message.includes(tc.expectedErrorSubstring)) {
                    throw new Error(
                        `Expected error containing "${tc.expectedErrorSubstring}", got: "${err.message}"`
                    );
                }
            }
        });
    }
}
