import { webrun } from "webrun/ctx";
export default async function(ctx) {
    const res = await webrun(["sub.js"]);
    if (res.exitCode !== 0) throw new Error("webrun run failed: " + res.stderr);
    if (!res.stdout.includes("sub_script_ok")) throw new Error("webrun stdout mismatch");
    console.log("RUN_OK");
}
