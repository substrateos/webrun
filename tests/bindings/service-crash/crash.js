export default {
    async fetch(req) {
        throw new Error("Simulated unhandled worker exception");
    }
}
