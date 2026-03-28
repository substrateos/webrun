export default {
    async fetch(req, env, ctx) {
        const url = new URL(req.url);

        if (url.pathname === "/echo") {
            const body = await req.text();
            return new Response(body, {
                status: 200,
                headers: { "x-echo": "true", "content-type": "text/plain" }
            });
        }

        if (url.pathname === "/json") {
            return new Response(JSON.stringify({ method: req.method, path: url.pathname }), {
                status: 200,
                headers: { "content-type": "application/json" }
            });
        }

        if (url.pathname === "/status") {
            const code = parseInt(url.searchParams.get("code") || "200");
            return new Response(`status:${code}`, { status: code });
        }

        if (url.pathname === "/headers") {
            const out = {};
            for (const [k, v] of req.headers) { out[k] = v; }
            return new Response(JSON.stringify(out), {
                headers: { "content-type": "application/json" }
            });
        }

        if (url.pathname === "/env") {
            return new Response(JSON.stringify(env || {}), {
                headers: { "content-type": "application/json" }
            });
        }

        return new Response("not found", { status: 404 });
    }
}
