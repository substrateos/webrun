// shared_registry.ts — Deduplication registry for shared runs.
//
// Maps resolved target paths to live RunHandle instances. When a handle's
// exitCode settles, the entry is automatically removed. Pure data structure.

import type { RunHandle } from "../types.ts";

type SharedRunHandle = Pick<RunHandle, "exitCode" | "urls">;

/**
 * Registry for shared run deduplication.
 *
 * - `acquire(key)` returns the existing handle if alive, null otherwise.
 * - `register(key, handle)` registers a new handle. Throws if key already exists.
 * - Auto-eviction: when a handle's `exitCode` settles, the entry is removed.
 */
export class SharedRegistry {
    private entries = new Map<string, SharedRunHandle>();

    /** Return the existing handle for this key, or null if none exists. */
    acquire(key: string): SharedRunHandle | null {
        return this.entries.get(key) ?? null;
    }

    /** Register a handle for this key. Throws if the key is already registered. */
    register(key: string, handle: SharedRunHandle): void {
        if (this.entries.has(key)) {
            throw new Error(`shared run already registered for key: ${key}`);
        }
        this.entries.set(key, handle);

        // Auto-evict when the process exits.
        handle.exitCode.then(() => {
            // Only delete if the entry still points to this handle
            // (guards against register → evict → re-register race).
            if (this.entries.get(key) === handle) {
                this.entries.delete(key);
            }
        });
    }
}
