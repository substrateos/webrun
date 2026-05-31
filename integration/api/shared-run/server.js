export default {
    fetch() {
        return new Response(crypto.randomUUID());
    }
}
