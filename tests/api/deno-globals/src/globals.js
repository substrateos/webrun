export default async function(ctx) {
    const leaks = [];
    if (typeof process !== 'undefined') leaks.push('process');
    if (typeof Buffer !== 'undefined') leaks.push('Buffer');
    if (typeof global !== 'undefined') leaks.push('global');
    if (typeof setImmediate !== 'undefined') leaks.push('setImmediate');
    if (typeof clearImmediate !== 'undefined') leaks.push('clearImmediate');
    if (typeof Deno !== 'undefined') leaks.push('Deno');

    if (leaks.length > 0) {
        console.error("LEAKED_GLOBALS:", leaks.join(', '));
        throw new Error("Leaked globals detected");
    } else {
        console.log("SECURE");
    }
}
