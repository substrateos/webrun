// slow.ts — Intentionally slow entrypoint to test location-scoped timeout.
export default function() {
    // Busy-wait for 5 seconds. If the location-scoped 500ms timeout
    // is properly applied, this should be killed well before completion.
    const start = Date.now();
    while (Date.now() - start < 5000) {}
    console.log("COMPLETED_WITHOUT_TIMEOUT");
}
