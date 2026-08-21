export default {
    async main(args, env, ctx) {
        const child = await ctx.run(["env"]);
        const exitCode = await child.exitCode;
        if (exitCode === 0) {
            console.log("PASS:binary_path_resolution");
        } else {
            console.log("FAIL:exit_code=" + exitCode);
        }
    }
}
