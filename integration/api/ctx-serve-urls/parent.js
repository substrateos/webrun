export default {
    async main(args, env, ctx) {
        const handle = await ctx.run(["--serve", "child.js"], { dir: ctx.dir });
        
        // Capture child stderr for diagnostics
        let childStderr = "";
        const stderrReader = handle.stderr.getReader();
        const dec = new TextDecoder();
        (async () => {
            try {
                while (true) {
                    const { done, value } = await stderrReader.read();
                    if (done) break;
                    childStderr += dec.decode(value);
                }
            } catch {}
        })();

        const urls = await handle.urls;
        const url = new URL(urls[0]);
        const auth = btoa(`${url.username}:${url.password}`);
        url.username = '';
        url.password = '';

        // The child needs time to bind — retry until it's ready.
        let body;
        for (let i = 0; i < 30; i++) {
            try {
                const res = await fetch(url, {
                    headers: { 'Authorization': `Basic ${auth}` }
                });
                body = await res.text();
                break;
            } catch {
                await new Promise(r => setTimeout(r, 200));
            }
        }
        if (body === undefined) {
            console.error("child stderr:", childStderr);
            throw new Error("child never became ready at " + url.href);
        }
        console.log(body);
        handle.signal("SIGTERM");
        await handle.exitCode;
    }
}
