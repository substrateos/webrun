export default async function(ctx) {
    if (typeof WorkerGlobalScope === "undefined") {
        throw new Error("WorkerGlobalScope is strictly undefined. Main entrypoint is not a worker wrapper.");
    }
    if (!(self instanceof WorkerGlobalScope)) {
        throw new Error("self is not an instance of WorkerGlobalScope");
    }
    console.log("ENTRYPOINT_IS_WORKER");
}
