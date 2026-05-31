import type {
    AsyncFileHandle,
    SyncFileHandle,
    SeekModes,
    FSRuntime,
} from "../../core/file_system/types.ts";

export type { FSRuntime };


class FileSystemWritableFileStream extends WritableStream<FileSystemWriteChunkType> {
    constructor(file: AsyncFileHandle, seekModes: SeekModes) {
        let position = 0;
        super({
            async write(chunk: FileSystemWriteChunkType) {
                let data: Uint8Array;
                let pos: number;
                if (typeof chunk === "string") {
                    data = new TextEncoder().encode(chunk);
                    pos = position;
                } else if (chunk instanceof ArrayBuffer) {
                    data = new Uint8Array(chunk);
                    pos = position;
                } else if (ArrayBuffer.isView(chunk)) {
                    data = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
                    pos = position;
                } else if (chunk instanceof Blob) {
                    data = new Uint8Array(await chunk.arrayBuffer());
                    pos = position;
                } else if (chunk.type === "write") {
                    const d = chunk.data;
                    if (d == null) {
                        data = new Uint8Array(0);
                    } else if (typeof d === "string") {
                        data = new TextEncoder().encode(d);
                    } else if (d instanceof ArrayBuffer) {
                        data = new Uint8Array(d);
                    } else if (d instanceof Blob) {
                        data = new Uint8Array(await d.arrayBuffer());
                    } else if (ArrayBuffer.isView(d)) {
                        data = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
                    } else {
                        throw new Error("Invalid write data type");
                    }
                    pos = chunk.position !== undefined && chunk.position !== null ? chunk.position : position;
                } else if (chunk.type === "truncate") {
                    if (chunk.size == null) throw new TypeError("truncate requires size");
                    await file.truncate(chunk.size);
                    return;
                } else if (chunk.type === "seek") {
                    if (chunk.position == null) throw new TypeError("seek requires position");
                    position = chunk.position;
                    return;
                } else {
                    throw new Error(`Unknown write chunk type`);
                }
                await file.seek(pos, seekModes.Start);
                await file.write(data);
                position = pos + data.byteLength;
            },
            close() { file.close(); }
        });
    }
    async seek(position: number) {
        const w = this.getWriter();
        await w.write({ type: "seek", position });
        w.releaseLock();
    }
    async truncate(size: number) {
        const w = this.getWriter();
        await w.write({ type: "truncate", size });
        w.releaseLock();
    }
    async write(chunk: FileSystemWriteChunkType) {
        const w = this.getWriter();
        await w.write(chunk);
        w.releaseLock();
    }
}

class FileSystemSyncAccessHandle {
    #file: SyncFileHandle;
    #seekModes: SeekModes;

    constructor(file: SyncFileHandle, seekModes: SeekModes) {
        this.#file = file;
        this.#seekModes = seekModes;
    }

    read(buffer: ArrayBufferView, options?: { at?: number }): number {
        if (options?.at !== undefined) {
            this.#file.seekSync(options.at, this.#seekModes.Start);
        }
        const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const bytesRead = this.#file.readSync(view);
        return bytesRead ?? 0;
    }

    write(buffer: ArrayBufferView, options?: { at?: number }): number {
        if (options?.at !== undefined) {
            this.#file.seekSync(options.at, this.#seekModes.Start);
        }
        const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        return this.#file.writeSync(view);
    }

    truncate(newSize: number): void {
        this.#file.truncateSync(newSize);
    }

    getSize(): number {
        const saved = this.#file.seekSync(0, this.#seekModes.Current);
        const size = this.#file.seekSync(0, this.#seekModes.End);
        this.#file.seekSync(saved, this.#seekModes.Start);
        return size;
    }

    flush(): void {
        this.#file.syncSync();
    }

    close(): void {
        this.#file.close();
    }
}




/**
 * Creates a complete OPFS-compatible storage layer, with all classes
 * closing over the injected rt runtime. Zero module-level mutable state.
 */
export default function makeFS(rt: FSRuntime) {
    let _getPath: (h: FileSystemHandle) => string | undefined;
    let _getRoot: (h: FileSystemHandle) => string | undefined;

    class SandboxFile extends File {
        #path: string;
        #size: number;
        constructor(path: string, name: string, size: number, options?: FilePropertyBag) {
            super([], name, options);
            this.#path = path;
            this.#size = size;
        }
        override get size() { return this.#size; }
        override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
            const ts = new TransformStream<Uint8Array<ArrayBuffer>>();
            rt.open(this.#path, { read: true })
                .then((file) => {
                    file.readable.pipeTo(ts.writable).catch((e: unknown) => console.warn("[webrun] file pipe error:", e));
                });
            return ts.readable;
        }
        override async arrayBuffer() {
            const data = await rt.readFile(this.#path);
            return data.buffer as ArrayBuffer;
        }
        override async text() {
            const data = await rt.readFile(this.#path);
            return new TextDecoder().decode(data);
        }
        override slice(start?: number, end?: number, contentType?: string): Blob {
            const s = start ?? 0;
            const e = end ?? this.#size;
            return new LazySliceBlob(this.#path, s, e, this.#size, { type: contentType ?? this.type });
        }
    }

    class LazySliceBlob extends Blob {
        #path: string;
        #start: number;
        #end: number;

        constructor(path: string, start: number, end: number, size: number, options?: BlobPropertyBag) {
            super([], options);
            this.#path = path;
            this.#start = start;
            this.#end = Math.min(end, size);
        }

        override get size() { return Math.max(0, this.#end - this.#start); }

        override async arrayBuffer() {
            const data = await rt.readFile(this.#path);
            return data.buffer.slice(this.#start, this.#end) as ArrayBuffer;
        }

        override async text() {
            const buf = await this.arrayBuffer();
            return new TextDecoder().decode(buf);
        }

        override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
            const path = this.#path;
            const start = this.#start;
            const end = this.#end;
            return new ReadableStream({
                async start(controller) {
                    const data = await rt.readFile(path);
                    controller.enqueue(new Uint8Array(data.buffer.slice(start, end) as ArrayBuffer));
                    controller.close();
                }
            });
        }

        override slice(start?: number, end?: number, contentType?: string): Blob {
            const s = start ?? 0;
            const e = end ?? this.size;
            const absStart = this.#start + Math.max(0, s);
            const absEnd = this.#start + Math.min(this.size, e);
            return new LazySliceBlob(this.#path, absStart, absEnd, this.#end, { type: contentType ?? this.type });
        }
    }

    class FileSystemHandleImpl implements FileSystemHandle {
        #path: string;
        #root: string;
        name: string;
        kind: "file" | "directory";
        constructor(kind: "file" | "directory", path: string, name: string, root?: string) {
            this.kind = kind;
            this.#path = path;
            this.#root = root ?? path;
            this.name = name;
        }
        static {
            _getPath = (h: any) => { return #path in h ? h.#path : undefined; };
            _getRoot = (h: any) => { return #root in h ? h.#root : undefined; };
        }
        async isSameEntry(other: any) {
            if (!other || typeof other !== 'object' || !(#path in other)) return false;
            return this.kind === other.kind && this.#path === other.#path;
        }
    }

    class FileSystemFileHandleImpl extends FileSystemHandleImpl implements FileSystemFileHandle {
        override readonly kind: "file" = "file";
        constructor(path: string, name: string, root?: string) { super('file', path, name, root); }
        async createWritable(opts: { keepExistingData?: boolean } = {}) {
            const file = await rt.open(_getPath(this)!, { write: true, create: true, truncate: !opts.keepExistingData });
            return new FileSystemWritableFileStream(file, rt.SeekMode);
        }
        async getFile() {
            const meta = await rt.stat(_getPath(this)!);
            const mtime = meta.mtime ? meta.mtime.getTime() : 0;
            return new SandboxFile(_getPath(this)!, this.name, meta.size, { lastModified: mtime });
        }
        async createSyncAccessHandle() {
            const file = rt.openSync(_getPath(this)!, { read: true, write: true });
            return new FileSystemSyncAccessHandle(file, rt.SeekMode);
        }
    }

    class FileSystemDirectoryHandleImpl extends FileSystemHandleImpl implements FileSystemDirectoryHandle {
        override readonly kind: "directory" = "directory";
        constructor(path: string, name: string, root?: string) { super('directory', path, name, root); }
        async getFileHandle(name: string, opts: { create?: boolean } = {}) {
            if (typeof name !== 'string' || name.includes("/") || name.includes(String.fromCharCode(92)) || name === ".." || name === ".") {
                throw new DOMException("Invalid file name.", "SecurityError");
            }
            const target = `${_getPath(this)!}/${name}`;
            if (opts.create) {
                await rt.writeFile(target, new Uint8Array(0), { create: true, append: true });
            } else {
                try {
                    const fi = await rt.stat(target);
                    if (fi.isDirectory) throw new DOMException("Type mismatch.", "TypeMismatchError");
                } catch (err) {
                    if (err instanceof rt.errors.NotFound) throw new DOMException("The requested file could not be found.", "NotFoundError");
                    throw err;
                }
            }
            return new FileSystemFileHandleImpl(target, name, _getRoot(this));
        }
        async getDirectoryHandle(name: string, opts: { create?: boolean } = {}) {
            if (typeof name !== 'string' || name.includes("/") || name.includes(String.fromCharCode(92)) || name === ".." || name === ".") {
                throw new DOMException("Invalid directory name.", "SecurityError");
            }
            const target = `${_getPath(this)!}/${name}`;
            if (opts.create) {
                await rt.mkdir(target, { recursive: true });
            } else {
                try {
                    const fi = await rt.stat(target);
                    if (!fi.isDirectory) throw new DOMException("Type mismatch.", "TypeMismatchError");
                } catch (err) {
                    if (err instanceof rt.errors.NotFound) throw new DOMException("The requested directory could not be found.", "NotFoundError");
                    throw err;
                }
            }
            return new FileSystemDirectoryHandleImpl(target, name, _getRoot(this));
        }
        async removeEntry(name: string, opts: { recursive?: boolean } = {}) {
            if (typeof name !== 'string' || name.includes("/") || name.includes(String.fromCharCode(92)) || name === ".." || name === ".") {
                throw new DOMException("Invalid entry name.", "SecurityError");
            }
            const target = `${_getPath(this)!}/${name}`;
            try {
                await rt.remove(target, { recursive: !!opts.recursive });
            } catch (err) {
                if (err instanceof rt.errors.NotFound) {
                    throw new DOMException("The requested entry could not be found.", "NotFoundError");
                }
                throw err;
            }
        }
        async *entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]> {
            const thisPath = _getPath(this)!;
            for await (const dirEntry of rt.readDir(thisPath)) {
                if (dirEntry.isFile) {
                    yield [dirEntry.name, new FileSystemFileHandleImpl(`${thisPath}/${dirEntry.name}`, dirEntry.name, _getRoot(this))] as const;
                } else if (dirEntry.isDirectory) {
                    yield [dirEntry.name, new FileSystemDirectoryHandleImpl(`${thisPath}/${dirEntry.name}`, dirEntry.name, _getRoot(this))] as const;
                }
            }
        }
        async *keys(): AsyncIterableIterator<string> {
            for await (const [name] of this.entries()) yield name;
        }
        async *values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle> {
            for await (const [, handle] of this.entries()) yield handle;
        }
        [Symbol.asyncIterator]() {
            return this.entries();
        }
        async resolve(possibleDescendant: FileSystemHandle) {
            if (await this.isSameEntry(possibleDescendant)) return [];
            const descendantPath = _getPath(possibleDescendant);
            const thisPath = _getPath(this)!;
            if (!descendantPath || !descendantPath.startsWith(thisPath + '/')) return null;
            return descendantPath.slice(thisPath.length + 1).split('/');
        }
    }

    return {
        FileSystemDirectoryHandle: FileSystemDirectoryHandleImpl,
        FileSystemFileHandle: FileSystemFileHandleImpl,
        resolveHandle: _getPath,
        resolveHandleRef: (h: FileSystemHandle): { root: string; path: string[] } => {
            const root = _getRoot(h);
            const path = _getPath(h);
            if (!root || !path) throw new Error("Handle is not a recognized FileSystemHandle implementation");
            const rel = path === root ? [] : path.slice(root.length + 1).split("/");
            return { root, path: rel };
        },
    };
}
