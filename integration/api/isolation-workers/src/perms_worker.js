self.onmessage = async () => {
    try {
        if (typeof Deno !== "undefined" && Deno.permissions) {
            const status = await Deno.permissions.query({ name: "env" });
            if (status.state === "granted") throw new Error("Worker got 'env' permissions unexpectedly!");
        }
        self.postMessage("SUCCESS_WORKER");
    } catch (e) {
        self.postMessage("FAILED_WORKER:" + e.message);
    }
};
