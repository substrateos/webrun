import * as ctx from "webrun/ctx";
export default async function() {
    if (ctx.flags.help) console.log("HELP_FLAG_PASSED");
}
