import { runTests } from "./framework.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

export async function testSandboxIsolationExecution(t: any) {
    await runTests(t, [
        {
            name: "Receives explicit arguments, environment variables, and parsed flags via ctx object",
            configs: { ".": { permissions: { env: ["API_KEY"], storage: { ".": { access: "read" } } } } },
            env: { "API_KEY": "test_123" },
            args: ["src/test.js", "--mode", "debug", "--verbose=true", "-f", "--", "val1", "val2"],
            scripts: {
                "src/test.js": async (ctx: any) => {
                    const { args, flags, env } = ctx;
                    const pos = [...args];
                    const apiKey = env.API_KEY;
                    const mode = flags.mode;
                    const verbose = flags.verbose;
                    const f = flags.f;

                    if (pos.join(",") === "val1,val2" && apiKey === "test_123" && mode === "debug" && String(verbose) === "true" && String(f) === "true") {
                        console.log("PARAMS_OK");
                    } else {
                        console.error("FAILED params:", pos, apiKey, mode, verbose, f);
                        throw new Error("Params mismatch");
                    }
                }
            },
            expectCode: 0,
            expectStdout: "PARAMS_OK"

        },
        {
            name: "Protects positional array from flag manipulation natively",
            configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
            args: ["src/test.js", "----", "hacked", "positionalValue"],
            scripts: {
                "src/test.js": async (ctx: any) => {
                    const { args, flags, argv, command, env } = ctx;
                    const pos = [...args];
                    if (pos[0] !== "positionalValue") throw new Error("Positional array overwritten");
                    if (flags[""] !== "hacked") throw new Error("Empty flag missing");
                    console.log("REACHED");
                }
            },
            expectCode: 0
        },
        {
            name: "argv adheres to POSIX/Node.js conventions with executable at index 0",
            configs: { ".": { permissions: { storage: { ".": { access: "read" } } } } },
            args: ["src/test.js", "--mode", "demo"],
            scripts: {
                "src/test.js": async (ctx: any) => {
                    const { argv } = ctx;
                    if (!argv || argv.length !== 4) throw new Error("argv length mismatch");
                    if (!argv[0].includes("webrun")) throw new Error("argv[0] does not contain webrun executable name");
                    if (argv[1] !== "src/test.js") throw new Error("argv[1] is not target script");
                    if (argv[2] !== "--mode") throw new Error("argv[2] is not --mode");
                    if (argv[3] !== "demo") throw new Error("argv[3] is not demo");
                    console.log("ARGV_OK");
                }
            },
            expectCode: 0,
            expectStdout: "ARGV_OK"
        }]);
}

