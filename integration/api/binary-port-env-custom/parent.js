export default {
    async main(args, env, ctx) {
        // Launch 'printenv' with --serve. portEnv is "MY_CUSTOM_PORT" in webrun.json,
        // so the allocated port should be injected under that name, not PORT.
        const handle = await ctx.run(["--serve", "/usr/bin/printenv", "MY_CUSTOM_PORT"]);

        const reader = handle.stdout.getReader();
        let bytes = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const b of value) bytes.push(b);
        }
        const stdout = new TextDecoder().decode(new Uint8Array(bytes)).trim();

        const exitCode = await handle.exitCode;
        if (exitCode !== 0) {
            const stderrReader = handle.stderr.getReader();
            const errBytes = [];
            while(true) {
                const { done, value } = await stderrReader.read();
                if(done) break;
                for(const b of value) errBytes.push(b);
            }
            console.log(`FAIL:printenv exited ${exitCode}. Stderr: ${new TextDecoder().decode(new Uint8Array(errBytes))}`);
            return;
        }

        const port = parseInt(stdout, 10);
        if (isNaN(port) || port <= 0) {
            console.log(`FAIL:port_not_numeric:${JSON.stringify(stdout)}`);
            return;
        }

        const urls = await handle.urls;
        const urlPort = urls.length > 0 ? new URL(urls[0]).port : "none";
        if (String(port) === urlPort) {
            console.log("PASS:custom_port_env");
        } else {
            console.log(`FAIL:port_mismatch:env=${port},url=${urlPort}`);
        }
    }
};
