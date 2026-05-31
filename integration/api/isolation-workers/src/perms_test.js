export default async function(ctx) {
    const worker = new Worker(new URL("./perms_worker.js", import.meta.url).href, { type: "module" });
    worker.postMessage("start");
    const res = await new Promise((resolve) => {
        worker.onmessage = (e) => resolve(e.data);
        worker.onerror = (e) => resolve("WORKER_ERROR");
    });
    if (res !== "SUCCESS_WORKER") throw new Error("Worker failed: " + res);
    console.log("SUCCESS");
}
