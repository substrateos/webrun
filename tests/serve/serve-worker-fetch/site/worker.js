export default {
    async fetch(req) {
        const method = req.method;
        const header = req.headers.get("x-webrun-test");
        return new Response(method + ":" + header);
    }
}
