/**
 * File System — Type Definitions
 *
 * Defines the runtime interface that platform adapters must
 * implement to provide OPFS-compatible file system access.
 * These types are the injection contract — the adapter
 * implements them, and createFS() consumes them.
 */

/** Async file handle — returned by rt.open(). */
export interface AsyncFileHandle {
    seek(offset: number, whence: number): Promise<number>;
    write(data: Uint8Array): Promise<number>;
    truncate(size: number): Promise<void>;
    close(): void;
    readonly readable: ReadableStream<Uint8Array>;
}

/** Sync file handle — returned by rt.openSync(). */
export interface SyncFileHandle {
    readSync(buf: Uint8Array): number | null;
    writeSync(buf: Uint8Array): number;
    seekSync(offset: number, whence: number): number;
    truncateSync(size: number): void;
    syncSync(): void;
    close(): void;
}

/** Seek origin constants. */
export interface SeekModes {
    Start: number;
    Current: number;
    End: number;
}

/**
 * The file system runtime contract.
 *
 * Platform adapters implement this interface to provide the
 * underlying FS operations. The shape is intentionally close
 * to Deno's built-in FS API so the Deno adapter is thin, but
 * any platform that can provide these operations works.
 */
export interface FSRuntime {
    stat(path: string | URL): Promise<{
        isDirectory: boolean;
        isFile: boolean;
        size: number;
        mtime: Date | null;
    }>;
    readFile(path: string | URL): Promise<Uint8Array>;
    writeFile(
        path: string | URL,
        data: Uint8Array,
        options?: { create?: boolean; append?: boolean },
    ): Promise<void>;
    remove(
        path: string | URL,
        options?: { recursive?: boolean },
    ): Promise<void>;
    mkdir(
        path: string | URL,
        options?: { recursive?: boolean },
    ): Promise<void>;
    readDir(
        path: string | URL,
    ): AsyncIterable<{
        name: string;
        isFile: boolean;
        isDirectory: boolean;
    }>;
    open(
        path: string | URL,
        options?: {
            read?: boolean;
            write?: boolean;
            create?: boolean;
            truncate?: boolean;
        },
    ): Promise<AsyncFileHandle>;
    openSync(
        path: string | URL,
        options?: { read?: boolean; write?: boolean },
    ): SyncFileHandle;
    errors: { NotFound: new (...args: any[]) => Error };
    SeekMode: SeekModes;
}
