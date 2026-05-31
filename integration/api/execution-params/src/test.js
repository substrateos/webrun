export default async function(ctx) {
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
