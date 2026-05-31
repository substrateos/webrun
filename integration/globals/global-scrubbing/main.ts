export default async function() {
    const leaks = [];
    if (typeof Deno !== "undefined") leaks.push("Deno");
    if (typeof process !== "undefined") leaks.push("process");
    if (typeof Buffer !== "undefined") leaks.push("Buffer");
    if (typeof global !== "undefined") leaks.push("global");
    if (typeof setImmediate !== "undefined") leaks.push("setImmediate");
    if (typeof clearImmediate !== "undefined") leaks.push("clearImmediate");

    if (leaks.length > 0) {
        console.log("LEAKED_GLOBALS: " + leaks.join(", "));
    } else {
        console.log("GLOBALS_CLEAN");
    }
}
