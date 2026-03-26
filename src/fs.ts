import { sys, printExecutionError } from "./sys.ts";
// =========================================================
// 3. PURE: WEB API VIRTUALIZATION
// =========================================================

export interface EnclaveAdapter {
    deno: any;
    resolvedStorageRoot: string;
}

export async function enforceEnclave(target: string, adapter: EnclaveAdapter) {
    try {
        const linfo = await adapter.deno.lstat(target);
        const rp = await adapter.deno.realPath(target).catch((err: any) => {
            if (err instanceof adapter.deno.errors.NotFound && linfo.isSymlink) {
                throw new DOMException("Broken symlinks are not permitted.", "SecurityError");
            }
            throw err;
        });
        if (rp !== adapter.resolvedStorageRoot && !rp.startsWith(adapter.resolvedStorageRoot + "/")) {
            throw new DOMException("Path resolves outside enclave.", "SecurityError");
        }
    } catch (e: any) {
        if (!(e instanceof adapter.deno.errors.NotFound)) throw e;
    }
}

export class FileSystemWritableFileStream extends WritableStream<any> {
    _file: any;
    constructor(file: any, adapter: EnclaveAdapter) {
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
                await file.seek(pos, adapter.deno.SeekMode.Start);
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

export class SandboxFile extends Blob {
    _path: string;
    _size: number;
    name: string;
    _adapter: EnclaveAdapter;
    constructor(path: string, name: string, size: number, adapter: EnclaveAdapter) {
        super([]);
        this._path = path;
        this._size = size;
        this.name = name;
        this._adapter = adapter;
    }
    override get size() { return this._size; }
    override stream(): any {
        const ts = new TransformStream();
        enforceEnclave(this._path, this._adapter)
            .then(() => this._adapter.deno.open(this._path, { read: true }))
            .then((file: any) => {
                file.readable.pipeTo(ts.writable).catch(() => { });
            });
        return ts.readable;
    }
    override async arrayBuffer() {
        await enforceEnclave(this._path, this._adapter);
        const data = await this._adapter.deno.readFile(this._path);
        return data.buffer;
    }
    override async text() {
        await enforceEnclave(this._path, this._adapter);
        const data = await this._adapter.deno.readFile(this._path);
        return new TextDecoder().decode(data);
    }
}

let _getPath: (h: any) => string | undefined;

export class FileSystemHandle {
    #path: string;
    name: string;
    kind: string;
    protected _adapter: EnclaveAdapter;
    constructor(kind: string, path: string, name: string, adapter: EnclaveAdapter) {
        this.kind = kind;
        this.#path = path;
        this.name = name;
        this._adapter = adapter;
    }
    static {
        _getPath = (h: any) => { return #path in h ? h.#path : undefined; };
    }
    async isSameEntry(other: any) {
        if (!other || typeof other !== 'object' || !(#path in other)) return false;
        return this.kind === other.kind && this.#path === other.#path;
    }
}

export class FileSystemFileHandle extends FileSystemHandle {
    constructor(path: string, name: string, adapter: EnclaveAdapter) { super('file', path, name, adapter); }
    async createWritable(opts: { keepExistingData?: boolean } = {}) {
        await enforceEnclave(_getPath(this)!, this._adapter);
        const file = await this._adapter.deno.open(_getPath(this)!, { write: true, create: true, truncate: !opts.keepExistingData });
        return new FileSystemWritableFileStream(file, this._adapter);
    }
    async getFile() {
        await enforceEnclave(_getPath(this)!, this._adapter);
        const meta = await this._adapter.deno.stat(_getPath(this)!);
        return new SandboxFile(_getPath(this)!, this.name, meta.size, this._adapter);
    }
}

export class FileSystemDirectoryHandle extends FileSystemHandle {
    constructor(path: string, name: string, adapter: EnclaveAdapter) { super('directory', path, name, adapter); }
    async getFileHandle(name: string, opts: any = {}) {
        if (typeof name !== 'string' || name.includes("/") || name.includes(String.fromCharCode(92)) || name === ".." || name === ".") {
            throw new DOMException("Invalid file name.", "SecurityError");
        }
        const target = `${_getPath(this)!}/${name}`;
        await enforceEnclave(target, this._adapter);
        if (opts.create) {
            await this._adapter.deno.writeFile(target, new Uint8Array(0), { create: true, append: true });
        } else {
            try {
                const fi = await this._adapter.deno.stat(target);
                if (fi.isDirectory) throw new DOMException("Type mismatch.", "TypeMismatchError");
            } catch (err) {
                if (err instanceof this._adapter.deno.errors.NotFound) throw new DOMException("The requested file could not be found.", "NotFoundError");
                throw err;
            }
        }
        return new FileSystemFileHandle(target, name, this._adapter);
    }
    async getDirectoryHandle(name: string, opts: any = {}) {
        if (typeof name !== 'string' || name.includes("/") || name.includes(String.fromCharCode(92)) || name === ".." || name === ".") {
            throw new DOMException("Invalid directory name.", "SecurityError");
        }
        const target = `${_getPath(this)!}/${name}`;
        await enforceEnclave(target, this._adapter);
        if (opts.create) {
            await this._adapter.deno.mkdir(target, { recursive: true });
        } else {
            try {
                const fi = await this._adapter.deno.stat(target);
                if (!fi.isDirectory) throw new DOMException("Type mismatch.", "TypeMismatchError");
            } catch (err) {
                if (err instanceof this._adapter.deno.errors.NotFound) throw new DOMException("The requested directory could not be found.", "NotFoundError");
                throw err;
            }
        }
        return new FileSystemDirectoryHandle(target, name, this._adapter);
    }
    async removeEntry(name: string, opts: any = {}) {
        if (typeof name !== 'string' || name.includes("/") || name.includes(String.fromCharCode(92)) || name === ".." || name === ".") {
            throw new DOMException("Invalid entry name.", "SecurityError");
        }
        const target = `${_getPath(this)!}/${name}`;
        await enforceEnclave(target, this._adapter);
        try {
            await this._adapter.deno.remove(target, { recursive: !!opts.recursive });
        } catch (err) {
            if (err instanceof this._adapter.deno.errors.NotFound) {
                throw new DOMException("The requested entry could not be found.", "NotFoundError");
            }
            throw err;
        }
    }
    async *entries() {
        const thisPath = _getPath(this)!;
        await enforceEnclave(thisPath, this._adapter);
        for await (const dirEntry of this._adapter.deno.readDir(thisPath)) {
            if (dirEntry.isFile) {
                yield [dirEntry.name, new FileSystemFileHandle(`${thisPath}/${dirEntry.name}`, dirEntry.name, this._adapter)];
            } else if (dirEntry.isDirectory) {
                yield [dirEntry.name, new FileSystemDirectoryHandle(`${thisPath}/${dirEntry.name}`, dirEntry.name, this._adapter)];
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

export class StorageManager {
    _storageRoot: string;
    _fallbackToTemp: boolean;
    _adapter: EnclaveAdapter;
    constructor(storageRoot: string, fallbackToTemp: boolean, adapter: EnclaveAdapter) {
        this._storageRoot = storageRoot;
        this._fallbackToTemp = fallbackToTemp;
        this._adapter = adapter;
    }
    async persisted() { return !this._fallbackToTemp; }
    async getDirectory() {
        return new FileSystemDirectoryHandle(this._storageRoot, "root", this._adapter);
    }
    async estimate() {
        return { quota: 0, usage: 0 };
    }
}

export function createStorageManager(storageRoot: string, fallbackToTemp: boolean) {
    const localDeno = sys;
    const resolvedStorageRoot = localDeno.realPathSync(storageRoot);
    const adapter: EnclaveAdapter = { deno: localDeno, resolvedStorageRoot };
    return new StorageManager(storageRoot, fallbackToTemp, adapter);
}

