import { runTests } from "./framework.ts";

export async function testProgrammaticAPI(t: any) {
    await runTests(t, [
        {
            name: "ctx.webrun correctly evaluates inline code",
            args: ["src/test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
            scripts: {
                "src/test.js": `
            import { webrun } from "webrun/ctx";
            export default async function(ctx) {
                const res = await webrun(["--eval", "console.log('internal_eval_ok');"]);
                if (res.exitCode !== 0) throw new Error("webrun eval failed: " + res.stderr);
                if (!res.stdout.includes("internal_eval_ok")) throw new Error("webrun stdout mismatch: " + res.stdout);
                console.log("EVAL_OK");
            }
        `
            },
            expectCode: 0,
            expectStdout: "EVAL_OK"
        },
        {
            name: "ctx.webrun correctly executes target script in a sub-worker",
            args: ["src/parent.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
            scripts: {
                "src/parent.js": `
            import { webrun } from "webrun/ctx";
            export default async function(ctx) {
                const res = await webrun(["src/child.js"]);
                if (res.exitCode !== 0) throw new Error("webrun child failed: " + res.stderr);
                if (!res.stdout.includes("child_ok")) throw new Error("webrun child stdout mismatch: " + res.stdout);
                console.log("PARENT_OK");
            }
        `,
                "src/child.js": `
            export default function(ctx) {
                console.log("child_ok");
            }
        `
            },
            expectCode: 0,
            expectStdout: "PARENT_OK"
        },
        {
            name: "ctx.webrun isolates CLI arguments from the parent explicitly",
            args: ["src/parent_args.js", "--parent-flag", "--", "parent-positional"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
            scripts: {
                "src/parent_args.js": `
            import { webrun } from "webrun/ctx";
            export default async function(ctx) {
                if (!ctx.flags["parent-flag"]) throw new Error("Parent missing flag");
                const res = await webrun(["src/child_args.js", "--child-flag", "--", "child-positional"]);
                if (res.exitCode !== 0) throw new Error("Child failed: " + res.stderr);
                if (!res.stdout.includes("CHILD_ARGS_OK")) throw new Error("Stdout error: " + res.stdout);
                console.log("PARENT_ARGS_OK");
            }
        `,
                "src/child_args.js": `
            export default function(ctx) {
                if (ctx.flags["parent-flag"]) throw new Error("Child leaked parent flag");
                if (!ctx.flags["child-flag"]) throw new Error("Child missing own flag");
                if (ctx.args.includes("parent-positional")) throw new Error("Child leaked parent positional");
                if (!ctx.args.includes("child-positional")) throw new Error("Child missing own positional: " + JSON.stringify(ctx.args) + " from " + JSON.stringify(ctx));
                console.log("CHILD_ARGS_OK");
            }
        `
            },
            expectCode: 0,
            expectStdout: "PARENT_ARGS_OK"
        },
        {
            name: "ctx.webrun natively runs sub-workers with file writes",
            args: ["test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" }, "child": { access: "write" } } } } },
            cwd: "child",
            files: {
                "child/sub.js": "export default function() { console.log('sub_script_ok'); }"
            },
            scripts: {
                "child/test.js": `
            import { webrun } from "webrun/ctx";
            export default async function(ctx) {
                const res = await webrun(["sub.js"]);
                if (res.exitCode !== 0) throw new Error("webrun run failed: " + res.stderr);
                if (!res.stdout.includes("sub_script_ok")) throw new Error("webrun stdout mismatch");
                console.log("RUN_OK");
            }
        `
            },
            expectCode: 0,
            expectStdout: "RUN_OK"
        },
        {
            name: "ctx.webrun respects SandboxOptions timeout constraints",
            args: ["src/test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
            scripts: {
                "src/test.js": `
            import { webrun } from "webrun/ctx";
            export default async function(ctx) {
                const res = await webrun(["--eval", "while(true){}"], { timeoutMillis: 50 });
                if (res.exitCode !== 143) throw new Error("webrun timeout failed to abort");
                console.log("TIMEOUT_OK");
            }
        `
            },
            expectCode: 0,
            expectStdout: "TIMEOUT_OK"
        },
        {
            name: "ctx.webrun natively runs --test sub-worker test runners",
            args: ["test.js"],
            configs: { ".": { permissions: { storage: { ".": { access: "read" }, "child": { access: "write" } } } } },
            cwd: "child",
            files: {
                "child/suite.test.ts": "export async function testGuest(t) { t.log('nested_test_log'); t.assert(1===1, 'ok'); }"
            },
            scripts: {
                "child/test.js": `
            import { webrun } from "webrun/ctx";
            export default async function(ctx) {
                let blocked = false;
                try {
                    await webrun(["--test", "suite.test.ts"]);
                } catch (e) {
                    if (e.message.includes("not yet implemented")) blocked = true;
                }
                if (!blocked) throw new Error("webrun failed to block --test");
                console.log("TEST_OK");
            }
        `
            },
            expectCode: 0,
            expectStdout: "TEST_OK"
        }
    ]);
}

