export default {
    async fetch(req, env, ctx) {
        return new Response(env.MY_VAR);
    }
}
