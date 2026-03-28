import { webrun } from "webrun/ctx";
export default async function(ctx) {
    const res = await webrun(["--some-flag"]);
    if (res.exitCode === 0) throw new Error("webrun unexpectedly succeeded without a target");
    if (!res.stderr.includes("No execution target specified")) throw new Error("webrun stderr missing target error: " + res.stderr);
    console.log("STRICT_TARGET_OK");
}
