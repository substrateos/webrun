/**
 * @webrun/deno/file_system — Filesystem extension.
 *
 * Captures Deno filesystem APIs before scrub and provides:
 * - ctx.dir — resolved working directory handle
 * - ctx.extensionData() — scoped persistent directory + hash function per extension
 * - ctx.makeTempDir() — creates temp directories
 * - ctx.createFileSystemHandleURL() — converts handles to file:// URLs
 *
 * Must run before @webrun/deno/scrub.
 */
import type { Extension } from "../../../extensions/mod.ts";
import createFS from "../../file_system/mod.ts";
import { createRunArgTag } from "../../../core/run_arg.ts";

const fileSystemExt: Extension = async (ctx, next, config) => {
    const Deno = (globalThis as any).Deno;

    const fs = createFS({
        stat: Deno.stat,
        readFile: Deno.readFile,
        writeFile: Deno.writeFile,
        remove: Deno.remove,
        mkdir: Deno.mkdir,
        readDir: Deno.readDir,
        open: Deno.open,
        openSync: Deno.openSync,
        errors: Deno.errors,
        SeekMode: Deno.SeekMode,
    });

    const extensionsDir = config.extensionsDir as string;

    // ctx.dir is populated only when the caller provides a dir path.
    // The caller gates this on whether storage is declared in the config.
    const dirPath = config.dir as string | undefined;
    const dir = dirPath ? new fs.FileSystemDirectoryHandle(dirPath, "dir") : undefined;

    const extensionData = async function(this: any) {
        const key = this.extensionKey;
        if (!key) throw new Error("extensionData() called outside extension context");

        const extPath = extensionsDir + "/" + key;
        const extDir = new fs.FileSystemDirectoryHandle(extPath, key, extensionsDir);
        // Ensure the extension directory exists, creating each segment.
        let parent = new fs.FileSystemDirectoryHandle(extensionsDir, "extensions", extensionsDir);
        for (const segment of key.split("/")) {
            parent = await parent.getDirectoryHandle(segment, { create: true });
        }

        return {
            dir: extDir,
            hashForFileSystemHandle: async (handle: any) => {
                const path = fs.resolveHandle(handle);
                const data = new TextEncoder().encode(key + ":" + path);
                const hash = await crypto.subtle.digest("SHA-256", data);
                return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
            },
        };
    };

    const createFileSystemHandleURL = (handle: any) => {
        const path = fs.resolveHandle(handle);
        const isDir = handle.kind === "directory";
        return `file://${path}${isDir ? "/" : ""}`;
    };

    const tempDir = config.tempDir as string;
    const makeTempDir = async (options?: { prefix?: string }) => {
        const prefix = options?.prefix || "tmp_";
        const uuid = crypto.randomUUID();
        const parentHandle = new fs.FileSystemDirectoryHandle(tempDir, "temp");
        return await parentHandle.getDirectoryHandle(`${prefix}${uuid}`, { create: true });
    };
    // Wrap ctx.run to serialize dir handles before IPC.
    // Handles from this factory use private fields that don't survive
    // structured cloning — resolve to a path string here.
    const origRun = ctx.run;
    const run: any = origRun
        ? async (args: any[], options?: any) => {
            if (options?.dir) {
                const ref = fs.resolveHandleRef(options.dir);
                options = { ...options, dir: fs.resolveHandle(options.dir), dirRoot: ref.root, dirPath: ref.path };
            }
            // Resolve storage grant handles to paths.
            if (options?.storage) {
                options = {
                    ...options,
                    storage: options.storage.map((g: any) => ({
                        ...g,
                        handle: g.handle,
                        _resolvedPath: fs.resolveHandle(g.handle),
                    })),
                };
            }
            return origRun(args, options);
        }
        : origRun;
    // Attach .arg template tag — this is where createFileSystemHandleURL is available.
    (run as any).arg = createRunArgTag(createFileSystemHandleURL);

    await next({ ...ctx, dir, run, createFileSystemHandleURL, makeTempDir, extensionData });
};

export default fileSystemExt;
