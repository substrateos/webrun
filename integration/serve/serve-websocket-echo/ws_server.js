export default {
    async fetch(req, ctx) {
        if (req.headers.get("upgrade") === "websocket") {
            const { socket, response } = ctx.upgradeWebSocket();
            socket.onmessage = (e) => {
                socket.send("ECHO:" + e.data);
            };
            return response;
        }
        return new Response("OK");
    }
}
