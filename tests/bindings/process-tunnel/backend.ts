const port = parseInt(Deno.env.get("PROCESS_PORT") || "0", 10);
Deno.serve({ port }, (req) => {
    return new Response("Process_Alive_On_" + port);
});
