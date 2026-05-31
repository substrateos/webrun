self.onmessage = () => {
    const leaks = [];
    if (typeof process !== 'undefined') leaks.push('process');
    if (typeof Buffer !== 'undefined') leaks.push('Buffer');
    if (typeof global !== 'undefined') leaks.push('global');
    if (typeof setImmediate !== 'undefined') leaks.push('setImmediate');
    if (typeof clearImmediate !== 'undefined') leaks.push('clearImmediate');
    if (typeof Deno !== 'undefined') leaks.push('Deno');

    if (typeof performance === 'undefined') leaks.push('missing_performance');
    else {
        if (!performance.memory) leaks.push('missing_memory');
        if (typeof performance.measureMemory !== 'function') leaks.push('missing_measureMemory');
    }

    if (leaks.length > 0) {
        self.postMessage("LEAKED_GLOBALS:" + leaks.join(', '));
    } else {
        self.postMessage("SECURE");
    }
};
