// Node globals shim: provides Buffer, setImmediate, clearImmediate, and process
// to the WebRTC bundle without leaking them onto globalThis.
//
// Strategy: During bundle initialization (import-time), the shim transparently
// delegates to the real globals which still exist on globalThis. After
// bootstrapWebRTC calls __initNodeGlobals, the shim captures the references
// internally. execution.ts then scrubs the globals. From that point on, only
// the bundle's module-scoped references remain — guest code cannot access them.

// IMPORTANT: These variables must NOT have initializers. See dgram.ts
// for the full explanation of the esbuild __esm lazy-init clobbering bug.
let _Buffer: any;
let _setImmediate: any;
let _clearImmediate: any;
let _process: any;
let initialized: boolean | undefined;

export function __initNodeGlobals(deps: {
    Buffer: any;
    setImmediate: any;
    clearImmediate: any;
    process: any;
}): void {
    if (initialized) throw new Error("Security Error: Node globals shim already initialized");
    initialized = true;
    _Buffer = deps.Buffer;
    _setImmediate = deps.setImmediate;
    _clearImmediate = deps.clearImmediate;
    _process = deps.process;

    // Self-destruct
    (globalThis as any).__initNodeGlobals = undefined;
}

// Resolve Buffer: prefer the injected reference, fall back to globalThis
// during module initialization (before __initNodeGlobals has been called).
function resolveBuffer(): any {
    if (_Buffer) return _Buffer;
    const g = (globalThis as any).Buffer;
    if (g) return g;
    throw new Error("Security Error: Buffer not available");
}

export const Buffer = new Proxy(function(){} as any, {
    get(_target, prop) {
        return resolveBuffer()[prop];
    },
    apply(_target, _thisArg, args) {
        return resolveBuffer()(...args);
    },
    construct(_target, args) {
        return new (resolveBuffer())(...args);
    },
    has(_target, prop) {
        return prop in resolveBuffer();
    },
    getPrototypeOf() {
        return Object.getPrototypeOf(resolveBuffer());
    }
});

function resolveSetImmediate(): any {
    if (_setImmediate) return _setImmediate;
    const g = (globalThis as any).setImmediate;
    if (g) return g;
    throw new Error("Security Error: setImmediate not available");
}

function resolveClearImmediate(): any {
    if (_clearImmediate) return _clearImmediate;
    const g = (globalThis as any).clearImmediate;
    if (g) return g;
    throw new Error("Security Error: clearImmediate not available");
}

export function setImmediate(callback: (...args: any[]) => void, ...args: any[]): any {
    return resolveSetImmediate()(callback, ...args);
}

export function clearImmediate(id: any): void {
    return resolveClearImmediate()(id);
}

// process shim: only exposes nextTick (used by thunky/multicast-dns).
function resolveProcess(): any {
    if (_process) return _process;
    const g = (globalThis as any).process;
    if (g) return g;
    throw new Error("Security Error: process not available");
}

export const process = new Proxy({} as any, {
    get(_target, prop) {
        return resolveProcess()[prop];
    },
    has(_target, prop) {
        return prop in resolveProcess();
    }
});
