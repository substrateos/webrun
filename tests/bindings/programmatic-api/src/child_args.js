export default function(ctx) {
    if (ctx.flags["parent-flag"]) throw new Error("Child leaked parent flag");
    if (!ctx.flags["child-flag"]) throw new Error("Child missing own flag");
    if (ctx.args.includes("parent-positional")) throw new Error("Child leaked parent positional");
    if (!ctx.args.includes("child-positional")) throw new Error("Child missing own positional: " + JSON.stringify(ctx.args) + " from " + JSON.stringify(ctx));
    console.log("CHILD_ARGS_OK");
}
