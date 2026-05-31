export default {
    async main(args, env, ctx) {
        // Launch 'printenv' as a binary with --serve.
        // --serve allocates an ephemeral port; binary mode should inject PORT into the env.
        const handle = await ctx.run(["--serve", "/usr/bin/printenv", "PORT"]);

        // Read stdout — printenv PORT prints the PORT value.
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

        // PORT should be a numeric string matching one of the serve URLs.
        const port = parseInt(stdout, 10);
        if (isNaN(port) || port <= 0) {
            console.log(`FAIL:port_not_numeric:${JSON.stringify(stdout)}`);
            return;
        }

        // Verify handle.urls contains a URL with that port.
        const urls = await handle.urls;
        const urlPort = urls.length > 0 ? new URL(urls[0]).port : "none";
        if (String(port) === urlPort) {
            console.log("PASS:port_injected");
        } else {
            console.log(`FAIL:port_mismatch:env=${port},url=${urlPort}`);
        }
    }
};
