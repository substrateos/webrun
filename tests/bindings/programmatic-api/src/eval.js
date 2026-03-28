import { webrun } from "webrun/ctx";
export default async function(ctx) {
    const res = await webrun(["--eval", "console.log('internal_eval_ok');"]);
    if (res.exitCode !== 0) throw new Error("webrun eval failed: " + res.stderr);
    if (!res.stdout.includes("internal_eval_ok")) throw new Error("webrun stdout mismatch: " + res.stdout);
    console.log("EVAL_OK");
}
