const port = parseInt(Deno.env.get("PORT") || "0", 10);
Deno.writeTextFileSync("tmp/child.pid", String(Deno.pid));
Deno.serve({ port }, (req) => {
    return new Response("OK");
});
