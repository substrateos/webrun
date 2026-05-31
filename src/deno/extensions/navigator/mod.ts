/**
 * @webrun/deno/navigator — Navigator polyfill extension.
 *
 * Sets up globalThis.navigator with a browser-like userAgent string.
 * Runs before scrub so it can set the navigator object while Deno
 * globals are still available.
 */
import type { Extension } from "../../../extensions/mod.ts";
import { BROWSER_USER_AGENT } from "../../../core/ua.ts";

const navigatorExt: Extension = async (ctx, next, _config) => {
    if (!(globalThis as any).navigator) {
        (globalThis as any).navigator = {};
    }

    Object.defineProperty((globalThis as any).navigator, "userAgent", {
        value: BROWSER_USER_AGENT,
        writable: false,
        configurable: true,
    });

    // Wrap fetch to inject a browser-like User-Agent when the caller
    // hasn't explicitly set one.
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        if (!headers.has("User-Agent")) {
            headers.set("User-Agent", BROWSER_USER_AGENT);
        }
        return nativeFetch(input, { ...init, headers });
    };

    return next(ctx);
};

export default navigatorExt;
