const SIGNAL_EXIT_CODES: Record<string, number> = {
    "SIGHUP": 129, "SIGINT": 130, "SIGTERM": 143,
};

interface SignalDeps {
    addSignalListener: typeof Deno.addSignalListener;
    exit: typeof Deno.exit;
}

/**
 * Bridge OS signals into an AbortSignal.
 * Terminal signals (SIGINT/SIGTERM/SIGHUP) abort + schedule exit.
 * User signals (SIGUSR1/SIGUSR2) dispatch repeatable events.
 * Listeners are lazily attached when the consumer subscribes.
 */
export default function makeSignal(deps: SignalDeps): AbortSignal {
    const ac = new AbortController();

    const listeners = new Set<string>();
    const addSignalListener = (sig: string) => {
        if (listeners.has(sig)) return;
        listeners.add(sig);
        if (["SIGINT", "SIGTERM", "SIGHUP"].includes(sig)) {
            deps.addSignalListener(sig as any, () => {
                const event = new Event(sig, { cancelable: true });
                ac.signal.dispatchEvent(event);
                if (!ac.signal.aborted) ac.abort(sig);
                if (!event.defaultPrevented) {
                    setTimeout(() => deps.exit(SIGNAL_EXIT_CODES[sig]), 10);
                }
            });
        } else if (["SIGUSR1", "SIGUSR2"].includes(sig)) {
            deps.addSignalListener(sig as any, () => {
                ac.signal.dispatchEvent(new Event(sig));
            });
        }
    };

    const originalAddEventListener = ac.signal.addEventListener;
    ac.signal.addEventListener = function (type: string, listener: any, options?: boolean | AddEventListenerOptions) {
        addSignalListener(type);
        return originalAddEventListener.call(this, type, listener, options);
    };

    return ac.signal;
}
