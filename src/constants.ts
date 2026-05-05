// =========================================================
// SHARED CONSTANTS
// =========================================================
//
// Values shared between host-side (import_proxy.ts) and
// guest-side (adapters/cli.ts, guest.ts) code. This module
// must remain free of host-only dependencies (node:net, etc.)
// so it can be bundled into the sandbox.

/**
 * Browser-like User-Agent string used for all external HTTP requests.
 * CDNs like esm.sh use the UA to select build targets — this ensures
 * webrun always receives browser-compatible ES module builds.
 *
 * This value is also exposed as `navigator.userAgent` inside the sandbox
 * to maintain identity consistency: the same UA that fetches modules is
 * the one scripts see at runtime.
 */
export const BROWSER_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * FNV-1a 32-bit hash of BROWSER_USER_AGENT, hex-encoded.
 * Used as a cache directory key so that changing the UA automatically
 * invalidates stale module caches (CDNs like esm.sh serve different
 * build targets based on UA).
 */
export const BROWSER_USER_AGENT_HASH = (() => {
    let h = 0x811c9dc5;
    for (let i = 0; i < BROWSER_USER_AGENT.length; i++) {
        h ^= BROWSER_USER_AGENT.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
})();
