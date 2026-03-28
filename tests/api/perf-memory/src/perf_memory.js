export default async function(ctx) {
    if (typeof performance === 'undefined') throw new Error("performance not defined");
    if (!performance.memory) throw new Error("performance.memory missing");
    if (typeof performance.memory.jsHeapSizeLimit !== 'number') throw new Error("jsHeapSizeLimit missing");
    if (typeof performance.memory.totalJSHeapSize !== 'number') throw new Error("totalJSHeapSize missing");
    if (typeof performance.memory.usedJSHeapSize !== 'number') throw new Error("usedJSHeapSize missing");

    if (typeof performance.measureMemory !== 'function') throw new Error("performance.measureMemory missing");
    const measurement = await performance.measureMemory();
    if (typeof measurement.bytes !== 'number') throw new Error("measurement.bytes missing");
    if (!Array.isArray(measurement.breakdown)) throw new Error("measurement.breakdown missing");
    console.log("SUCCESS");
}
