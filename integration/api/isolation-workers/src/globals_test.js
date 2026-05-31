export default async function(ctx) {
    const worker = new Worker(new URL("./globals_worker.js", import.meta.url).href, { type: "module" });
    worker.postMessage("start");
    const res = await new Promise((resolve) => {
        worker.onmessage = (e) => resolve(e.data);
        worker.onerror = (e) => resolve("WORKER_ERROR");
    });

    if (res !== "SECURE") {
        console.error(res);
        throw new Error("Worker leaked globals detected");
    }
    console.log("SUCCESS");
}
