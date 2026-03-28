export default {
    async fetch(req) {
        const text = await req.text();
        if (text === "hello") {
            return new Response("world_from_worker", { headers: { "X-Custom": "Foo" } });
        }
        return new Response("bad");
    }
}
