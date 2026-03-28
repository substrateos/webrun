export default function(ctx) {
    if (ctx.args[0] !== "pos-arg") throw new Error("Missing trailing pos-arg");
    console.log("child_ok_pos");
}
