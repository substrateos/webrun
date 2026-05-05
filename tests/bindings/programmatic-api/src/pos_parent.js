import { webrun } from "webrun/ctx";
export default async function(ctx) {
    const res = await webrun(["src/child_pos.js", "pos-arg"]);
    if (res.exitCode !== 0) throw new Error("webrun child failed: " + res.stderr);
    if (!res.stdout.includes("child_ok_pos")) throw new Error("webrun child stdout mismatch: " + res.stdout);
    console.log("POS_TARGET_OK");
}
