// extensions/opfs/mod.ts — @webrun/opfs extension.
//
// Resolves the navigator.storage directory for sandboxed scripts.
// Persistent storage is keyed by origin strategy (path) under
// the extension's own persistent directory. Ephemeral storage uses
// a temp dir that is cleaned up on exit.

import type { Context, ExtensionContext } from "../../core/types.ts";
import type { Extension } from "../mod.ts";
import { writeTextFile, readTextFile } from "../../core/io.ts";

class StorageManager {
    #root: FileSystemDirectoryHandle;
    #persisted: boolean;
    constructor(root: FileSystemDirectoryHandle, persisted: boolean) {
        this.#root = root;
        this.#persisted = persisted;
    }
    async persisted() { return this.#persisted; }
    async getDirectory() { return this.#root; }
    async estimate() { return { quota: 0, usage: 0 }; }
}

/**
 * Resolves the OPFS storage directory.
 *
 * - "path": bucket keyed by ctx.hashForFileSystemHandle(ctx.dir).
 * - undefined: ephemeral temp dir, destroyed on exit.
 */
async function resolveStorage(
    ctx: ExtensionContext,
    origin: "path" | undefined,
): Promise<{ handle: FileSystemDirectoryHandle; isEphemeral: boolean }> {
    if (origin !== "path") {
        const handle = await ctx.makeTempDir({ prefix: "webrun_opfs_" });
        return { handle, isEphemeral: true };
    }

    const { dir: extDir, hashForFileSystemHandle } = await ctx.extensionData();
    const originDir = await extDir.getDirectoryHandle(origin, { create: true });

    const bucketId = await hashForFileSystemHandle(ctx.dir);

    const bucketDir = await originDir.getDirectoryHandle(bucketId, { create: true });
    const fsDir = await bucketDir.getDirectoryHandle("fs", { create: true });

    // Write audit entry via handle API.
    try {
        let existing = "";
        try { existing = await readTextFile(bucketDir, ["audit.ndjson"]); } catch (_) { }
        const entry = JSON.stringify({
            timestamp: new Date().toISOString(),
            origin,
            bucketId,
            location: ctx.location,
            args: ctx.args,
        }) + "\n";
        await writeTextFile(bucketDir, ["audit.ndjson"], existing + entry);
    } catch (_) { }

    return { handle: fsDir, isEphemeral: false };
}

const opfs: Extension = async (ctx, next, config) => {
    const origin = config.origin as "path" | undefined;

    const { handle, isEphemeral } = await resolveStorage(ctx, origin);

    // Install navigator.storage shim.
    if (typeof navigator !== "undefined") {
        Object.defineProperty(navigator, "storage", {
            value: new StorageManager(handle, !isEphemeral),
            configurable: true,
        });
    }

    await next({
        ...ctx,
        extensions: {
            ...ctx.extensions,
            "@webrun/opfs": { navigatorStorageDirectory: handle, isEphemeral },
        },
    });

    // Cleanup ephemeral storage after execution.
    if (isEphemeral) {
        try {
            // Remove all entries in the temp dir.
            for await (const key of (handle as any).keys()) {
                await handle.removeEntry(key, { recursive: true });
            }
        } catch (_) { }
    }
};

export default opfs;
