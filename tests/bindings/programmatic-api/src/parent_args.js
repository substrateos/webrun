import { webrun } from "webrun/ctx";
export default async function(ctx) {
    if (!ctx.flags["parent-flag"]) throw new Error("Parent missing flag");
    const res = await webrun(["src/child_args.js", "--child-flag", "--", "child-positional"]);
    if (res.exitCode !== 0) throw new Error("Child failed: " + res.stderr);
    if (!res.stdout.includes("CHILD_ARGS_OK")) throw new Error("Stdout error: " + res.stdout);
    console.log("PARENT_ARGS_OK");
}
