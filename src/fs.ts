import type { StorageRuntime } from "./types.ts";

// =========================================================
// 3. PURE: WEB API VIRTUALIZATION
// =========================================================

/**
 * Creates a complete OPFS-compatible storage layer, with all classes
 * closing over the injected sys runtime. Zero module-level mutable state.
 */
export function createStorageModule(sys: StorageRuntime) {

    let _getPath: (h: any) => string | undefined;

    class FileSystemHandle {
        #path: string;
        name: string;
        kind: string;
        constructor(kind: string, path: string, name: string) {
            this.kind = kind;
            this.#path = path;
            this.name = name;
        }
        static {
            _getPath = (h: any) => { return #path in h ? h.#path : undefined; };
        }
        async isSameEntry(other: any) {
            if (!other || typeof other !== 'object' || !(#path in other)) return false;
            return this.kind === other.kind && this.#path === other.#path;
        }
    }

    class FileSystemWritableFileStream extends WritableStream<any> {
        _file: any;
        constructor(file: any) {
            let position = 0;
            super({
                async write(chunk: any) {
                    let data, pos;
                    if (typeof chunk === "string") {
                        data = new TextEncoder().encode(chunk);
                        pos = position;
                    } else if (chunk.type === "write") {
                        data = typeof chunk.data === "string" ? new TextEncoder().encode(chunk.data) : chunk.data;
                        pos = chunk.position !== undefined ? chunk.position : position;
                    } else if (chunk.type === "truncate") {
                        await file.truncate(chunk.size);
                        return;
                    } else if (chunk.type === "seek") {
                        position = chunk.position;
                        return;
                    } else {
                        data = chunk;
                        pos = position;
                    }
                    await file.seek(pos, sys.SeekMode.Start);
                    await file.write(data);
                    position = pos + data.byteLength;
                },
                close() { file.close(); }
            });
            this._file = file;
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
        async write(chunk: any) {
            const w = this.getWriter();
            await w.write(chunk);
            w.releaseLock();
        }
    }

    class FileSystemSyncAccessHandle {
        _file: any;

        constructor(file: any) {
            this._file = file;
        }

        read(buffer: ArrayBufferView, options?: { at?: number }): number {
            if (options?.at !== undefined) {
                this._file.seekSync(options.at, sys.SeekMode.Start);
            }
            const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            const bytesRead = this._file.readSync(view);
            return bytesRead ?? 0;
        }

        write(buffer: ArrayBufferView, options?: { at?: number }): number {
            if (options?.at !== undefined) {
                this._file.seekSync(options.at, sys.SeekMode.Start);
            }
            const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            return this._file.writeSync(view);
        }

        truncate(newSize: number): void {
            this._file.truncateSync(newSize);
        }

        getSize(): number {
            const saved = this._file.seekSync(0, sys.SeekMode.Current);
            const size = this._file.seekSync(0, sys.SeekMode.End);
            this._file.seekSync(saved, sys.SeekMode.Start);
            return size;
        }

        flush(): void {
            this._file.syncSync();
        }

        close(): void {
            this._file.close();
        }
    }

    class LazySliceBlob extends Blob {
        _path: string;
        _start: number;
        _end: number;

        constructor(path: string, start: number, end: number, size: number, type?: string) {
            super([], type ? { type } : undefined);
            this._path = path;
            this._start = start;
            this._end = Math.min(end, size);
        }

        override get size() { return Math.max(0, this._end - this._start); }

        override async arrayBuffer() {
            const data = await sys.readFile(this._path);
            return data.buffer.slice(this._start, this._end) as ArrayBuffer;
        }

        override async text() {
            const buf = await this.arrayBuffer();
            return new TextDecoder().decode(buf);
        }

        override stream(): any {
            const path = this._path;
            const start = this._start;
            const end = this._end;
            return new ReadableStream({
                async start(controller) {
                    const data = await sys.readFile(path);
                    controller.enqueue(new Uint8Array(data.buffer.slice(start, end)));
                    controller.close();
                }
            });
        }

        override slice(start?: number, end?: number, contentType?: string): Blob {
            const s = start ?? 0;
            const e = end ?? this.size;
            const absStart = this._start + Math.max(0, s);
            const absEnd = this._start + Math.min(this.size, e);
            return new LazySliceBlob(this._path, absStart, absEnd, this._end, contentType ?? this.type);
        }
    }

    class SandboxFile extends File {
        _path: string;
        _size: number;
        constructor(path: string, name: string, size: number, lastModified: number) {
            super([], name, { lastModified });
            this._path = path;
            this._size = size;
        }
        override get size() { return this._size; }
        override stream(): any {
            const ts = new TransformStream();
            sys.open(this._path, { read: true })
                .then((file: any) => {
                    file.readable.pipeTo(ts.writable).catch(() => { });
                });
            return ts.readable;
        }
        override async arrayBuffer() {
            const data = await sys.readFile(this._path);
            return data.buffer as ArrayBuffer;
        }
        override async text() {
            const data = await sys.readFile(this._path);
            return new TextDecoder().decode(data);
        }
        override slice(start?: number, end?: number, contentType?: string): Blob {
            const s = start ?? 0;
            const e = end ?? this._size;
            return new LazySliceBlob(this._path, s, e, this._size, contentType);
        }
    }

    class FileSystemFileHandle extends FileSystemHandle {
        constructor(path: string, name: string) { super('file', path, name); }
        async createWritable(opts: { keepExistingData?: boolean } = {}) {
            const file = await sys.open(_getPath(this)!, { write: true, create: true, truncate: !opts.keepExistingData });
            return new FileSystemWritableFileStream(file);
        }
        async getFile() {
            const meta = await sys.stat(_getPath(this)!);
            const mtime = meta.mtime ? meta.mtime.getTime() : 0;
            return new SandboxFile(_getPath(this)!, this.name, meta.size, mtime);
        }
        async createSyncAccessHandle() {
            const file = sys.openSync(_getPath(this)!, { read: true, write: true });
            return new FileSystemSyncAccessHandle(file);
        }
    }

    class FileSystemDirectoryHandle extends FileSystemHandle {
        constructor(path: string, name: string) { super('directory', path, name); }
        async getFileHandle(name: string, opts: any = {}) {
            if (typeof name !== 'string' || name.includes("/") || name.includes(String.fromCharCode(92)) || name === ".." || name === ".") {
                throw new DOMException("Invalid file name.", "SecurityError");
            }
            const target = `${_getPath(this)!}/${name}`;
            if (opts.create) {
                await sys.writeFile(target, new Uint8Array(0), { create: true, append: true });
            } else {
                try {
                    const fi = await sys.stat(target);
                    if (fi.isDirectory) throw new DOMException("Type mismatch.", "TypeMismatchError");
                } catch (err) {
                    if (err instanceof sys.errors.NotFound) throw new DOMException("The requested file could not be found.", "NotFoundError");
                    throw err;
                }
            }
            return new FileSystemFileHandle(target, name);
        }
        async getDirectoryHandle(name: string, opts: any = {}) {
            if (typeof name !== 'string' || name.includes("/") || name.includes(String.fromCharCode(92)) || name === ".." || name === ".") {
                throw new DOMException("Invalid directory name.", "SecurityError");
            }
            const target = `${_getPath(this)!}/${name}`;
            if (opts.create) {
                await sys.mkdir(target, { recursive: true });
            } else {
                try {
                    const fi = await sys.stat(target);
                    if (!fi.isDirectory) throw new DOMException("Type mismatch.", "TypeMismatchError");
                } catch (err) {
                    if (err instanceof sys.errors.NotFound) throw new DOMException("The requested directory could not be found.", "NotFoundError");
                    throw err;
                }
            }
            return new FileSystemDirectoryHandle(target, name);
        }
        async removeEntry(name: string, opts: any = {}) {
            if (typeof name !== 'string' || name.includes("/") || name.includes(String.fromCharCode(92)) || name === ".." || name === ".") {
                throw new DOMException("Invalid entry name.", "SecurityError");
            }
            const target = `${_getPath(this)!}/${name}`;
            try {
                await sys.remove(target, { recursive: !!opts.recursive });
            } catch (err) {
                if (err instanceof sys.errors.NotFound) {
                    throw new DOMException("The requested entry could not be found.", "NotFoundError");
                }
                throw err;
            }
        }
        async *entries() {
            const thisPath = _getPath(this)!;
            for await (const dirEntry of sys.readDir(thisPath)) {
                if (dirEntry.isFile) {
                    yield [dirEntry.name, new FileSystemFileHandle(`${thisPath}/${dirEntry.name}`, dirEntry.name)];
                } else if (dirEntry.isDirectory) {
                    yield [dirEntry.name, new FileSystemDirectoryHandle(`${thisPath}/${dirEntry.name}`, dirEntry.name)];
                }
            }
        }
        async *keys() {
            for await (const [name] of this.entries()) yield name;
        }
        async *values() {
            for await (const [, handle] of this.entries()) yield handle;
        }
        [Symbol.asyncIterator]() {
            return this.entries();
        }
        async resolve(possibleDescendant: any) {
            if (await this.isSameEntry(possibleDescendant)) return [];
            const descendantPath = _getPath(possibleDescendant);
            const thisPath = _getPath(this)!;
            if (!descendantPath || !descendantPath.startsWith(thisPath + '/')) return null;
            return descendantPath.slice(thisPath.length + 1).split('/');
        }
    }

    return { FileSystemDirectoryHandle, FileSystemFileHandle };
}

/** Return type of createStorageModule — avoids repeating the full signature. */
export type StorageModule = ReturnType<typeof createStorageModule>;

export class StorageManager {
    _storageRoot: string;
    _fallbackToTemp: boolean;
    _module: StorageModule;
    constructor(module: StorageModule, storageRoot: string, fallbackToTemp: boolean) {
        this._module = module;
        this._storageRoot = storageRoot;
        this._fallbackToTemp = fallbackToTemp;
    }
    async persisted() { return !this._fallbackToTemp; }
    async getDirectory() {
        return new this._module.FileSystemDirectoryHandle(this._storageRoot, "root");
    }
    async estimate() {
        return { quota: 0, usage: 0 };
    }
}

export function createStorageManager(sys: StorageRuntime, storageRoot: string, fallbackToTemp: boolean) {
    const module = createStorageModule(sys);
    return { manager: new StorageManager(module, storageRoot, fallbackToTemp), ...module };
}
