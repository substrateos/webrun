const port = parseInt(Deno.env.get("PORT") || "0", 10);
Deno.serve({ port }, (req) => {
    return new Response(JSON.stringify({
        allowed: Deno.env.get("ALLOWED_VAR"),
        leaked: Deno.env.get("HOST_LEAK")
    }));
});
