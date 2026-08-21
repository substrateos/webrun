export default {
    async main(args, env, ctx) {
        // Inject a malicious PATH. Since webrun.json allows "env": ["PATH"], this WILL be passed to the child process.
        // However, it MUST NOT affect the host's resolution of the bare command "env".
        const child = await ctx.run(["env"], { env: { PATH: "/tmp/malicious/hacked/path" } });
        const exitCode = await child.exitCode;
        if (exitCode === 0) {
            console.log("PASS:binary_path_injection_prevented");
        } else {
            console.log("FAIL:exit_code=" + exitCode);
        }
        const stdoutBytes = await new Response(child.stdout).arrayBuffer();
        const stdout = new TextDecoder().decode(stdoutBytes);
        if (stdout.includes("PATH=/tmp/malicious/hacked/path")) {
            console.log("PASS:env_passed_to_child");
        } else {
            console.log("FAIL:env_not_passed");
        }
    }
}
