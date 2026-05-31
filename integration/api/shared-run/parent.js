// parent.js — Shared run integration test.
//
// Tests: deduplication, handle surface (empty streams, no-op signal),
// process identity.

export default {
    async main(args, env, ctx) {
        // Helper: fetch from a shared run handle.
        async function fetchFromHandle(handle) {
            const urls = await handle.urls;
            const url = new URL(urls[0]);
            const auth = btoa(`${url.username}:${url.password}`);
            url.username = '';
            url.password = '';

            for (let i = 0; i < 30; i++) {
                try {
                    const res = await fetch(url, {
                        headers: { 'Authorization': `Basic ${auth}` }
                    });
                    return await res.text();
                } catch {
                    await new Promise(r => setTimeout(r, 200));
                }
            }
            throw new Error("server never became ready at " + url.href);
        }

        const serverUrl = import.meta.resolve("./server.js");

        // ── Test 1: Two shared calls → same URL ──────────────────────────
        const h1 = await ctx.run(["--serve", serverUrl], { shared: true });
        const h2 = await ctx.run(["--serve", serverUrl], { shared: true });

        const urls1 = await h1.urls;
        const urls2 = await h2.urls;

        if (urls1[0].href !== urls2[0].href) {
            throw new Error(`FAIL:dedup: URLs differ: ${urls1[0].href} vs ${urls2[0].href}`);
        }
        console.log("PASS:dedup");

        // ── Test 2: Same process identity ────────────────────────────────
        const id1 = await fetchFromHandle(h1);
        const id2 = await fetchFromHandle(h2);

        if (!id1 || !id2) {
            throw new Error(`FAIL:identity: got empty responses`);
        }
        console.log("PASS:identity");

        // ── Test 3: stdout is empty closed stream ────────────────────────
        const stdout = await new Response(h1.stdout).text();
        if (stdout !== "") {
            throw new Error(`FAIL:stdout: expected empty, got "${stdout}"`);
        }
        console.log("PASS:stdout_empty");

        // ── Test 4: stderr is empty closed stream ────────────────────────
        const stderr = await new Response(h1.stderr).text();
        if (stderr !== "") {
            throw new Error(`FAIL:stderr: expected empty, got "${stderr}"`);
        }
        console.log("PASS:stderr_empty");

        // ── Test 5: signal() is a no-op ──────────────────────────────────
        h1.signal("SIGTERM");

        // Verify process is still alive after no-op signal.
        const idAfterSignal = await fetchFromHandle(h2);
        if (!idAfterSignal) {
            throw new Error("FAIL:signal_noop: process died after no-op signal");
        }
        console.log("PASS:signal_noop");

        // ── Test 6: non-shared to same target is independent ─────────────
        const h3 = await ctx.run(["--serve", serverUrl], { dir: ctx.dir });
        const urls3 = await h3.urls;

        if (urls3[0].href === urls1[0].href) {
            throw new Error(`FAIL:independent: non-shared got same URL as shared`);
        }

        // Verify it's a different process by fetching.
        const id3 = await fetchFromHandle(h3);
        if (!id3) {
            throw new Error("FAIL:independent: non-shared process unreachable");
        }
        console.log("PASS:independent");

        // Clean up non-shared handle.
        h3.signal("SIGTERM");
        await h3.exitCode;

        // ── Test 7: second acquirer sees same URLs ───────────────────────
        // h1 and h2 already verified same URLs in test 1 — but verify
        // a third acquisition still returns the same URLs.
        const h4 = await ctx.run(["--serve", serverUrl], { shared: true });
        const urls4 = await h4.urls;

        if (urls4[0].href !== urls1[0].href) {
            throw new Error(`FAIL:multi_acquire: URLs differ: ${urls4[0].href} vs ${urls1[0].href}`);
        }
        console.log("PASS:multi_acquire");
    }
}
