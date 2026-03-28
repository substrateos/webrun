export default async function(ctx) {
    const res = await fetch(ctx.bindings.my_backend);
    const text = await res.text();
    if (!text.startsWith("Process_Alive_On_")) throw new Error("Tunnel failed: " + text);
    console.log("PROCESS_TUNNEL_OK");
}
