import { runTests } from "./framework.ts";

export async function testCLI(t: any) {
    await runTests(t, [
        {
            name: "Prints help screen when --help is passed",
            args: ["--help"],
            expectCode: 0,
        },
        {
            name: "Passes --help to target script when script is provided first",
            args: ["src/test.js", "--help"],
            scripts: {
                "src/test.js": `
                    import * as ctx from "webrun/ctx";
                    export default async function() {
                        if (ctx.flags.help) console.log("HELP_FLAG_PASSED");
                    }
                `
            },
            expectCode: 0,
            expectStdout: "HELP_FLAG_PASSED"
        },
        {
            name: "Prints version when --version is passed",
            args: ["--version"],
            expectCode: 0,
            expectStdout: "webrun dev"
        },
        {
            name: "Blocks import maps within a writable directory proactively",
            args: ["src/test.js"],
            configs: { ".": { importMap: "my_import_map.json", permissions: { storage: { ".": { access: "write" } } } } },
            files: {
                "my_import_map.json": JSON.stringify({})
            },
            scripts: {
                "src/test.js": async () => { }
            },
            expectCode: 1,
            expectStderr: [
                "[Security Fatal] The webrun file is within a permitted write directory. Refusing to run.",
                "  Executable:"
            ]
        },
        {
            name: "Merges parent and child import maps with child precedence",
            args: ["test.js"],
            configs: {
                ".": { importMap: "parent_map.json", permissions: { storage: { ".": { access: "read" } } } },
                "child": { importMap: "child_map.json" }
            },
            files: {
                "parent_map.json": JSON.stringify({ imports: { "parent-mod": "data:text/javascript,export const p = 1;", "shared": "data:text/javascript,export const s = 1;" } }),
                "child/child_map.json": JSON.stringify({ imports: { "child-mod": "data:text/javascript,export const c = 2;", "shared": "data:text/javascript,export const s = 2;" } }),
            },
            cwd: "child",
            scripts: {
                "child/test.js": `
            import { p } from "parent-mod";
            import { c } from "child-mod";
            import { s } from "shared";
            export default function() {
                if (p !== 1) throw new Error("Parent missing");
                if (c !== 2) throw new Error("Child missing");
                if (s !== 2) throw new Error("Child did not override parent shared");
                console.log("MERGED_OK");
            }
        `
            },
            expectCode: 0,
            expectStdout: "MERGED_OK"
        },
        {
            name: "Resolves relative scope keys safely against their declaring map directory",
            args: ["test.js"],
            configs: {
                ".": { importMap: "parent_map.json", permissions: { storage: { ".": { access: "read" } } } },
                "child": { importMap: "child_map.json", permissions: { storage: { ".": { access: "read" }, "../parent-scope": { access: "read" } } } }
            },
            files: {
                "parent_map.json": JSON.stringify({
                    scopes: {
                        "./parent-scope/": {
                            "utils_mod": "data:text/javascript,export const a = 'parent-a';"
                        }
                    }
                }),
                "parent-scope/app.ts": `
                import { a } from "utils_mod";
                export const pApp = a;
            `,
                "child/child_map.json": JSON.stringify({
                    scopes: {
                        "./child-scope/": {
                            "utils_mod": "data:text/javascript,export const a = 'child-a';"
                        }
                    }
                }),
                "child/child-scope/app.ts": `
                import { a } from "utils_mod";
                export const cApp = a;
            `,
            },
            cwd: "child",
            scripts: {
                "child/test.js": `
            import { pApp } from "../parent-scope/app.ts";
            import { cApp } from "./child-scope/app.ts";
            export default function() {
                if (pApp !== 'parent-a') throw new Error("Parent scope failed: " + pApp);
                if (cApp !== 'child-a') throw new Error("Child scope failed: " + cApp);
                console.log("SCOPES_OK");
            }
        `
            },
            expectCode: 0,
            expectStdout: "SCOPES_OK"
        },
        {
            name: "--test accepts multiple test files and runs them all natively",
            args: ["--test", "suite_a.test.ts", "suite_b.test.ts"],
            files: {
                "suite_a.test.ts": "export function testOne(t: any) { t.log('RUNNING SUITE A'); }",
                "suite_b.test.ts": "export function testTwo(t: any) { t.log('RUNNING SUITE B'); }"
            },
            expectCode: 0,
            expectStdout: "RUNNING SUITE A",
            expectStderr: ""
        },
        {
            name: "--check-only catches TS type errors and does not execute",
            args: ["--check-only", "invalid_types.ts"],
            files: {
                "invalid_types.ts": `
                    const x: number = "not a number";
                    throw new Error("SHOULD_NOT_RUN_TS");
                `
            },
            expectCode: 1,
            expectStderr: ["Type 'string' is not assignable to type 'number'"]
        },
        {
            name: "--check-only catches JS syntax errors and does not execute",
            args: ["--check-only", "invalid_syntax.js"],
            files: {
                "invalid_syntax.js": `
                    const x = ;
                    throw new Error("SHOULD_NOT_RUN_JS");
                `
            },
            expectCode: 1
        },
        {
            name: "--check-only accepts multiple files and does not execute them",
            args: ["--check-only", "valid1.ts", "valid2.js"],
            files: {
                "valid1.ts": `
                    export const x: number = 42;
                    throw new Error("SHOULD_NOT_RUN_VALID_1");
                `,
                "valid2.js": `
                    export const y = 42;
                    throw new Error("SHOULD_NOT_RUN_VALID_2");
                `
            },
            expectCode: 0
        },
        {
            name: "Default execution ignores TS type errors natively",
            args: ["run_invalid_types_bypass.ts"],
            files: {
                "run_invalid_types_bypass.ts": `
                    const x: number = "not a number";
                    console.log("BYPASS_SUCCESS_" + typeof x);
                `
            },
            expectCode: 0,
            expectStdout: "BYPASS_SUCCESS_string",
            expectStderr: ""
        }
    ]);
}

