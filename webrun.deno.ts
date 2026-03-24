import { resolve, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { pathToFileURL } from "node:url";

export interface Sys {
    realPathSync(path: string): string;
    removeSync(path: string, options?: { recursive?: boolean }): void;
    statSync(path: string): { isFile: boolean, isDirectory: boolean, isSymlink: boolean };
    exit(code?: number): never;
    env: { get(key: string): string | undefined };
    readTextFileSync(path: string): string;
    writeTextFileSync(path: string, data: string): void;
    mkdirSync(path: string, options?: { recursive?: boolean }): void;
    makeTempDirSync(options?: { prefix?: string }): string;
    execPath(): string;
    Command: any;
    CommandOptions: any;
    cwd(): string;
    args: string[];
    build: { os: string };
    memoryUsage(): { rss: number, heapTotal: number, heapUsed: number, external: number };
    test(options: any): void;
    // Async FS
    lstat(path: string): Promise<{ isSymlink: boolean }>;
    realPath(path: string): Promise<string>;
    remove(path: string, options?: { recursive?: boolean }): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    readDir(path: string): AsyncIterable<{ name: string, isFile: boolean, isDirectory: boolean, isSymlink: boolean }>;
    open(path: string, options?: any): Promise<any>;
    openSync(path: string, options?: any): any;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array, options?: any): Promise<void>;
    stat(path: string): Promise<{ isFile: boolean, isDirectory: boolean, size: number, mtime: Date | null }>;
    errors: { NotFound: any, AlreadyExists: any };
    SeekMode: { Start: number, Current: number, End: number };
}

export const sys: Sys = {
    realPathSync: Deno.realPathSync,
    removeSync: Deno.removeSync,
    statSync: Deno.statSync,
    exit: Deno.exit,
    env: Deno.env,
    readTextFileSync: Deno.readTextFileSync,
    writeTextFileSync: Deno.writeTextFileSync,
    mkdirSync: Deno.mkdirSync,
    makeTempDirSync: Deno.makeTempDirSync,
    execPath: Deno.execPath,
    Command: Deno.Command,
    CommandOptions: {},
    cwd: Deno.cwd,
    args: Deno.args,
    build: Deno.build,
    memoryUsage: Deno.memoryUsage.bind(Deno),
    test: Deno.test,
    lstat: Deno.lstat,
    realPath: Deno.realPath,
    remove: Deno.remove,
    mkdir: Deno.mkdir,
    readDir: Deno.readDir,
    open: Deno.open,
    openSync: Deno.openSync,
    readFile: Deno.readFile,
    writeFile: Deno.writeFile,
    stat: Deno.stat,
    errors: Deno.errors,
    SeekMode: Deno.SeekMode
};

function tryRealpathSync(p: string): string | undefined {
    try { return sys.realPathSync(p); } catch { return undefined; }
}

function tryRemoveSync(p: string, options?: { recursive?: boolean }): void {
    try { sys.removeSync(p, options); } catch { /* Ignored */ }
}

function tryStatSync(p: string): { isFile: boolean, isDirectory: boolean, isSymlink: boolean } | undefined {
    try { return sys.statSync(p); } catch { return undefined; }
}

export function printUsageError(msg: string) {
    console.error(`[Usage] ${msg}`);
}
export function printWarning(msg: string) {
    console.error(`[Warning] ${msg}`);
}
export function printExecutionError(msg: string, detail?: string) {
    console.error(`[Execution Error] ${msg}`);
    if (detail) console.error(`  ${detail}`);
}
export function printFatalError(msg: string, detail?: string) {
    console.error(`[Fatal] ${msg}`);
    if (detail) console.error(`  ${detail}`);
}
export function printSecurityFatal(msg: string, details?: Record<string, string>) {
    console.error(`[Security Fatal] ${msg}`);
    if (details) {
        for (const [k, v] of Object.entries(details)) {
            console.error(`  ${k.padEnd(10)}: ${v}`);
        }
    }
}

// =========================================================
// 1. TYPES & DOMAIN MODELS
// =========================================================
export interface WebrunConfig {
    limits?: { timeoutMillis?: number, memoryMB?: number };
    permissions?: {
        storage?: Record<string, { access: "read" | "write" }>;
        network?: string[];
        env?: string[];
    };
    importMap?: string;
}
export interface CommandInvocation {
    action: "run" | "test" | "eval";
    isSelfTest?: boolean;
    targetScriptPath: string | string[];
    evalCode?: string;
    sandboxArgs: string[];
    injectedArgsObj: Record<string, any>;
    networkFlags: string[];
}

export interface SandboxContextPayload {
    action: "run" | "test" | "eval";
    isSelfTest?: boolean;
    webrunBin?: string;
    isRepackedTest?: boolean;
    storageRoot: string;
    fallbackToTemp: boolean;
    injectedArgsObj: Record<string, any>;
    finalEnvVars: Record<string, string>;
    targetUrlHref: string | string[];
    targetScriptPath: string | string[];
    evalCode?: string;
    sandboxArgs: string[];
    opfsRoot: string;
    memoryMB?: number;
}

// =========================================================
// 2. PURE: CONFIGURATION & PARSING
// =========================================================

export interface ParsedArgs {
    isTest: boolean;
    isSelfTest: boolean;
    isEval: boolean;
    evalCode: string;
    targetScriptPath: string | string[];
    sandboxArgs: string[];
    injectedArgsObj: Record<string, any>;
}

export function parseRawArguments(args: string[]): ParsedArgs {
    const rawArgs = [...args];
    let isTest = false;
    let isSelfTest = false;
    let isEval = false;
    let evalCode = "";

    let targetScriptPath: string | string[] = "";
    const injectedArgsObj: Record<string, any> = { "--": [] };
    let onlyPositional = false;
    const testPaths: string[] = [];
    let scriptFound = false;

    const evalIdxExt = rawArgs.findIndex(a => a === "--eval" || a === "-e");
    if (evalIdxExt !== -1) {
        if (evalIdxExt + 1 < rawArgs.length && rawArgs[evalIdxExt + 1] !== "--") {
            evalCode = rawArgs[evalIdxExt + 1];
            rawArgs.splice(evalIdxExt, 2);
            isEval = true;
            scriptFound = true;
            targetScriptPath = "[eval]";
        } else {
            printUsageError("Usage: webrun --eval <code> [args...]");
            sys.exit(1);
        }
    }

    const selfTestIdx = rawArgs.indexOf("--self-test");
    if (selfTestIdx !== -1) {
        isTest = true;
        isSelfTest = true;
        const testPayload = rawArgs[selfTestIdx + 1];
        if (testPayload && !testPayload.startsWith("-")) {
            testPaths.push(testPayload);
            rawArgs.splice(selfTestIdx, 2);
        } else {
            rawArgs.splice(selfTestIdx, 1);
        }
    }

    const testIdx = rawArgs.indexOf("--test");
    if (testIdx !== -1) {
        isTest = true;
        rawArgs.splice(testIdx, 1);
    }

    if (rawArgs.length === 0 && !isTest && !isEval) {
        printUsageError("Usage: webrun [options] <script.ts> [args...]\\nRun with --help for documentation.");
        sys.exit(1);
    }

    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i];
        if (onlyPositional) {
            if (isTest && !isSelfTest) {
                testPaths.push(arg);
            } else if (isSelfTest) {
                printSecurityFatal("The --self-test execution mode strictly forbids external file paths.");
                sys.exit(1);
            } else {
                injectedArgsObj["--"].push(arg);
            }
            continue;
        }
        if (arg === "--") {
            onlyPositional = true;
            continue;
        }
        if (arg.startsWith("-")) {
            let key = arg.replace(/^-+/, "");
            let val: string | boolean = "";
            const eqIdx = key.indexOf("=");
            if (eqIdx !== -1) {
                val = key.slice(eqIdx + 1);
                key = key.slice(0, eqIdx);
            } else if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("-") && rawArgs[i + 1] !== "--") {
                val = rawArgs[++i];
            } else {
                val = true;
            }
            injectedArgsObj[key] = val;
        } else {
            if (!isTest) {
                if (!scriptFound) {
                    targetScriptPath = arg;
                    scriptFound = true;
                } else {
                    injectedArgsObj["--"].push(arg);
                }
            } else if (isTest && !isSelfTest) {
                testPaths.push(arg);
                scriptFound = true;
            } else if (isSelfTest) {
                printSecurityFatal("The --self-test execution mode strictly forbids external file paths.");
                sys.exit(1);
            }
        }
    }

    if (isTest) {
        if (testPaths.length === 0) {
            printUsageError("Usage: webrun --test [options] <script1.ts> ...\\nRun with --help for documentation.");
            sys.exit(1);
        }
        targetScriptPath = testPaths;
    } else if (!isEval) {
        if (!scriptFound) {
            printUsageError("Usage: webrun [options] <script.ts> [args...]\\nRun with --help for documentation.");
            sys.exit(1);
        }
    }

    return {
        isTest,
        isSelfTest,
        isEval,
        evalCode,
        targetScriptPath: targetScriptPath!,
        sandboxArgs: rawArgs,
        injectedArgsObj
    };
}

export function resolveExecutionMode(parsed: ParsedArgs): "run" | "test" | "eval" {
    if (parsed.isEval) return "eval";
    if (parsed.isTest) return "test";
    return "run";
}

export function buildNetworkFlags(allowedDomains: string[]): string[] {
    const SSRF_BLOCK = "--deny-net=127.0.0.0/8,localhost,0.0.0.0/8,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,169.254.0.0/16";
    const networkFlags: string[] = [];
    if (allowedDomains.length > 0) {
        networkFlags.push(`--allow-net=${allowedDomains.join(",")}`);
        networkFlags.push(SSRF_BLOCK);
    } else {
        networkFlags.push("--deny-net");
    }
    return networkFlags;
}

export function parseCommandInvocation(args: string[], config: WebrunConfig): CommandInvocation {
    const parsed = parseRawArguments(args);
    const action = resolveExecutionMode(parsed);
    const networkFlags = buildNetworkFlags(config.permissions?.network || []);

    return {
        action,
        isSelfTest: parsed.isSelfTest,
        targetScriptPath: parsed.targetScriptPath,
        evalCode: parsed.evalCode,
        sandboxArgs: parsed.sandboxArgs,
        injectedArgsObj: parsed.injectedArgsObj,
        networkFlags
    };
}

export function computeRuntimeEnvironment(allowedEnv: string[] = []): Record<string, string> {
    const finalEnvVars: Record<string, string> = {};
    for (const k of allowedEnv) {
        finalEnvVars[k] = sys.env.get(k) || "";
    }
    return finalEnvVars;
}

export interface EnclavePolicy {
    isPwdAllowed: boolean;
    fallbackToTemp: boolean;
    storageRoot: string;
    allowedReadPaths: string[];
    allowedWritePaths: string[];
}

export function evaluateEnclavePolicy(configDirs: Record<string, { access: "read" | "write" }>, configDir: string, currentDir: string, isolatedTmp: string): EnclavePolicy {
    let isPwdAllowed = false;
    const fallbackToTemp = Object.keys(configDirs).length === 0;

    const allowedReadPaths: string[] = [];
    const allowedWritePaths: string[] = [];

    for (const [fsPath, settings] of Object.entries(configDirs)) {
        const absFsPath = resolve(configDir, fsPath);
        if (currentDir === absFsPath || currentDir.startsWith(absFsPath + "/")) {
            isPwdAllowed = true;
        }

        allowedReadPaths.push(absFsPath);
        if (settings.access === "write") {
            allowedWritePaths.push(absFsPath);
        }
    }

    if (fallbackToTemp) {
        allowedReadPaths.push(currentDir);
    }

    return {
        isPwdAllowed,
        fallbackToTemp,
        allowedReadPaths,
        allowedWritePaths,
        storageRoot: fallbackToTemp ? isolatedTmp : currentDir
    };
}

export function generateDenoStorageFlags(policy: EnclavePolicy, isolatedTmp: string, runnerTmp: string, opfsTmp: string): string[] {
    const r = [isolatedTmp, ...policy.allowedReadPaths, runnerTmp, opfsTmp];
    const w = [isolatedTmp, ...policy.allowedWritePaths, opfsTmp];
    return [
        `--allow-read=${r.join(",")}`,
        `--allow-write=${w.join(",")}`
    ];
}

export function generateSeatbeltEnclaveStrings(policy: EnclavePolicy, runnerTmp: string, opfsTmp: string): { readEnclaves: string, writeEnclaves: string } {
    let readEnclaves = "";
    let writeEnclaves = "";

    for (const p of policy.allowedReadPaths) {
        readEnclaves += `\n    (subpath "${p}")`;
    }
    readEnclaves += `\n    (subpath "${runnerTmp}")`;

    for (const p of policy.allowedWritePaths) {
        writeEnclaves += `\n    (subpath "${p}")`;
    }
    writeEnclaves += `\n    (subpath "${opfsTmp}")`;

    return { readEnclaves, writeEnclaves };
}

export function generateSeatbeltProfile(cwd: string, readEnclaves: string, writeEnclaves: string): string {
    return `(version 1)
(deny default)
(import "bsd.sb")
(allow file-read-metadata)
(allow signal)
(allow system-fsctl)
(deny process-exec)
(deny process-fork)

(allow file-read* (literal "${cwd}"))

(allow process-exec
    (literal (param "WEBRUN_DENO_BIN_PATH"))
)

(allow file-read*
    (subpath "/usr/lib")
    (subpath "/usr/local/lib")
    (subpath "/System/Library")
    (subpath "/opt/homebrew")
    (literal "/dev/random")
    (literal "/dev/urandom")
    (literal "/dev/null")
    (literal "/dev/tty")
    (literal "/etc/resolv.conf") 
    (literal "/etc/hosts")       
    (literal "/private/etc/resolv.conf") 
    (literal "/private/etc/hosts")       
    (literal "/private/etc/services")       
    (literal "/private/var/run/mDNSResponder")
)

(allow file-read* file-map-executable
    (subpath (param "WEBRUN_DENO_BIN_DIR"))
)

(allow system-socket)
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow network-outbound
    (remote tcp "*:443")
    (remote tcp "*:80")  
    (remote udp "*:53")  
    (literal "/private/var/run/mDNSResponder")
)

(allow file-read* file-write*
    (subpath (param "WEBRUN_SANDBOX_CACHE"))
    (subpath (param "WEBRUN_ISOLATED_TMP"))${writeEnclaves}
)

(allow file-read*
    (literal (param "WEBRUN_DENO_JSON"))
    (literal (param "WEBRUN_DENO_JSONC"))
    (literal (param "WEBRUN_DENO_LOCK"))
    (literal (param "WEBRUN_SCRIPT_PATH"))${readEnclaves}
)

(deny file-read* file-write*
    (regex #"^.*/\\.env.*$")
)
`;
}

export function generateBaseImportMap(): any {
    const sinkholeURI = "data:text/javascript,export default null; throw new Error('Security Error: Node/NPM modules are blocked.');";

    const contextCode = `
export let args = [];
export let flags = {};
export let env = {};
export let dir = undefined;
export let command = "";
export let persisted = false;

let isSet = false;

export function set(ctx) {
    if (isSet) throw new Error("Security Error: webrun/ctx is already initialized");
    isSet = true;
    args = ctx.args || [];
    flags = ctx.flags || {};
    env = ctx.env || {};
    dir = ctx.dir;
    command = ctx.command || "";
    persisted = !!ctx.persisted;
}
`;
    const contextURI = `data:application/typescript;charset=utf-8,${encodeURIComponent(contextCode)}`;

    return {
        imports: {
            "webrun/ctx": contextURI,
            "node:fs": sinkholeURI,
            "node:child_process": sinkholeURI,
            "node:net": sinkholeURI,
            "node:os": sinkholeURI,
            "node:path": sinkholeURI,
            "node:vm": sinkholeURI,
        },
        scopes: {}
    };
}

export function rewriteImportMapPathsToAbsolute(userMap: any, baseDir: string): void {
    const rewriteToAbsolute = (obj: Record<string, string>) => {
        if (!obj) return;
        for (const [key, value] of Object.entries(obj)) {
            if (value.startsWith("./") || value.startsWith("../")) {
                let resolved = "file://" + resolve(baseDir, value);
                if (value.endsWith("/") && !resolved.endsWith("/")) resolved += "/";
                obj[key] = resolved;
            }
        }
    };

    if (userMap.imports) {
        rewriteToAbsolute(userMap.imports);
    }

    if (userMap.scopes) {
        const newScopes: any = {};
        for (const [scopeKey, scopeValue] of Object.entries(userMap.scopes)) {
            rewriteToAbsolute(scopeValue as any);
            let resolvedScopeKey = scopeKey;
            if (scopeKey.startsWith("./") || scopeKey.startsWith("../")) {
                resolvedScopeKey = "file://" + resolve(baseDir, scopeKey);
                if (scopeKey.endsWith("/") && !resolvedScopeKey.endsWith("/")) {
                    resolvedScopeKey += "/";
                }
            }
            newScopes[resolvedScopeKey] = scopeValue;
        }
        userMap.scopes = newScopes;
    }
}

export function mergeImportMaps(targetMap: any, sourceMap: any): void {
    if (sourceMap.imports) {
        Object.assign(targetMap.imports, sourceMap.imports);
    }
    if (sourceMap.scopes) {
        for (const [scopeKey, scopeValue] of Object.entries(sourceMap.scopes)) {
            if (!targetMap.scopes[scopeKey]) {
                targetMap.scopes[scopeKey] = {};
            }
            Object.assign(targetMap.scopes[scopeKey], scopeValue);
        }
    }
}

export function buildNodeSinkholeDependencies(isolatedTmp: string, importMapPaths: string[] = []): string {
    const importMapPayload = generateBaseImportMap();

    for (const absMapPath of importMapPaths) {
        try {
            const userMap = JSON.parse(sys.readTextFileSync(absMapPath));
            rewriteImportMapPathsToAbsolute(userMap, dirname(absMapPath));
            mergeImportMaps(importMapPayload, userMap);
        } catch (e: any) {
            printWarning(`Failed to parse or merge importMap at ${absMapPath}: ${e.message}`);
        }
    }

    const combinedPath = resolve(isolatedTmp, "sandbox_import_map.json");
    sys.writeTextFileSync(combinedPath, JSON.stringify(importMapPayload));
    return combinedPath;
}

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

// =========================================================
// 4. IMPURE: EXECUTION LIFECYCLES
// =========================================================

export interface FoundConfig {
    config: WebrunConfig;
    dir: string;
    path: string;
}

export function findLocalConfigurations(currentDir: string): FoundConfig[] {
    let configDir = currentDir;
    const allConfigs: FoundConfig[] = [];

    while (true) {
        const potentialWebrunPath = resolve(configDir, "webrun.json");
        const potentialPackagePath = resolve(configDir, "package.json");

        let foundConfig: any = null;
        let foundPath = "";

        try {
            if (sys.statSync(potentialWebrunPath).isFile) {
                foundConfig = JSON.parse(sys.readTextFileSync(potentialWebrunPath));
                foundPath = potentialWebrunPath;
            }
        } catch (_) { }

        if (!foundConfig) {
            try {
                if (sys.statSync(potentialPackagePath).isFile) {
                    const pkgInfo = JSON.parse(sys.readTextFileSync(potentialPackagePath));
                    if (pkgInfo.webrun && typeof pkgInfo.webrun === "object") {
                        foundConfig = pkgInfo.webrun;
                        foundPath = potentialPackagePath;
                    }
                }
            } catch (_) { }
        }

        if (foundConfig) {
            if (!foundConfig.permissions) foundConfig.permissions = { storage: {}, network: [], env: [] };
            if (!foundConfig.permissions.storage) foundConfig.permissions.storage = {};
            if (!foundConfig.permissions.network) foundConfig.permissions.network = [];
            if (!foundConfig.permissions.env) foundConfig.permissions.env = [];

            allConfigs.push({ config: foundConfig, dir: configDir, path: foundPath });
        }

        const parent = resolve(configDir, "..");
        if (parent === configDir) break;
        configDir = parent;
    }

    return allConfigs;
}

export function validatePrivilegeNarrowing(parentConfig: WebrunConfig, parentDir: string, childConfig: WebrunConfig, childDir: string) {
    if (parentConfig.limits) {
        if (parentConfig.limits.timeoutMillis !== undefined && childConfig.limits?.timeoutMillis !== undefined && childConfig.limits.timeoutMillis > parentConfig.limits.timeoutMillis) {
            printSecurityFatal("Privilege escalation detected in nested configuration.", {
                Reason: "Escalating 'timeoutMillis' limit",
                Attempted: String(childConfig.limits.timeoutMillis),
                Permitted: String(parentConfig.limits.timeoutMillis),
                Child: childDir,
                Parent: parentDir
            });
            sys.exit(1);
        }
        if (parentConfig.limits.memoryMB !== undefined && childConfig.limits?.memoryMB !== undefined && childConfig.limits.memoryMB > parentConfig.limits.memoryMB) {
            printSecurityFatal("Privilege escalation detected in nested configuration.", {
                Reason: "Escalating 'memoryMB' limit",
                Attempted: String(childConfig.limits.memoryMB),
                Permitted: String(parentConfig.limits.memoryMB),
                Child: childDir,
                Parent: parentDir
            });
            sys.exit(1);
        }
    }

    for (const e of childConfig.permissions!.env!) {
        if (!parentConfig.permissions!.env!.includes(e)) {
            printSecurityFatal("Privilege escalation detected in nested configuration.", {
                Reason: "Escalating 'env' permissions",
                Attempted: e,
                Child: childDir,
                Parent: parentDir
            });
            sys.exit(1);
        }
    }

    for (const n of childConfig.permissions!.network!) {
        if (!parentConfig.permissions!.network!.includes(n)) {
            printSecurityFatal("Privilege escalation detected in nested configuration.", {
                Reason: "Escalating 'network' permissions",
                Attempted: n,
                Child: childDir,
                Parent: parentDir
            });
            sys.exit(1);
        }
    }

    const parentStorageAbs = Object.entries(parentConfig.permissions!.storage!).map(([k, v]: [string, any]) => ({ path: resolve(parentDir, k), access: v.access }));
    const childStorageAbs = Object.entries(childConfig.permissions!.storage!).map(([k, v]: [string, any]) => ({ path: resolve(childDir, k), access: v.access }));

    for (const c of childStorageAbs) {
        let covered = false;
        for (const p of parentStorageAbs) {
            if (c.path === p.path || c.path.startsWith(p.path + "/")) {
                if (c.access === "write" && p.access !== "write") {
                    continue;
                }
                covered = true;
                break;
            }
        }
        if (!covered) {
            printSecurityFatal("Privilege escalation detected in nested configuration.", {
                Reason: "Escalating 'storage' permissions",
                Attempted: c.path,
                Child: childDir,
                Parent: parentDir
            });
            sys.exit(1);
        }
    }
}

export function mergeConfigurations(allConfigs: FoundConfig[], defaultDir: string): { config: WebrunConfig, configDir: string, configFound: boolean, configPaths: string[], importMapPaths: string[] } {
    const importMapPaths: string[] = [];
    const finalConfig: WebrunConfig = { limits: { timeoutMillis: 120000, memoryMB: 512 }, permissions: { storage: {}, network: [], env: [] } };
    let finalConfigDir = defaultDir;
    let configFound = false;

    if (allConfigs.length > 0) {
        configFound = true;
        const mostSpecific = allConfigs[0];
        finalConfigDir = mostSpecific.dir;

        for (let i = 0; i < allConfigs.length - 1; i++) {
            validatePrivilegeNarrowing(allConfigs[i + 1].config, allConfigs[i + 1].dir, allConfigs[i].config, allConfigs[i].dir);
        }

        Object.assign(finalConfig.permissions!, mostSpecific.config.permissions);

        for (let i = allConfigs.length - 1; i >= 0; i--) {
            const cfg = allConfigs[i].config;
            if (cfg.importMap) {
                importMapPaths.push(resolve(allConfigs[i].dir, cfg.importMap));
            }
        }

        for (let i = allConfigs.length - 1; i >= 0; i--) {
            const cfg = allConfigs[i].config;
            if (cfg.limits) {
                if (cfg.limits.timeoutMillis !== undefined) finalConfig.limits!.timeoutMillis = Math.min(finalConfig.limits!.timeoutMillis!, cfg.limits.timeoutMillis);
                if (cfg.limits.memoryMB !== undefined) finalConfig.limits!.memoryMB = Math.min(finalConfig.limits!.memoryMB!, cfg.limits.memoryMB);
            }
        }
    }

    return { config: finalConfig, configDir: finalConfigDir, configFound, configPaths: allConfigs.map(c => c.path), importMapPaths };
}

export function resolveLocalConfiguration(currentDir: string): { config: WebrunConfig, configDir: string, configFound: boolean, configPaths: string[], importMapPaths: string[] } {
    const allConfigs = findLocalConfigurations(currentDir);
    return mergeConfigurations(allConfigs, currentDir);
}


class WebrunSkipError extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "WebrunSkipError";
    }
}

function createGuestTestContext(denoCtx: any): any {
    return {
        name: denoCtx.name,
        async run(subName: string, subFn: Function) {
            await denoCtx.step(subName, async (subT: any) => {
                await subFn(createGuestTestContext(subT));
            });
        },
        log(...args: any[]) { console.log(...args); },
        assert(cond: any, msg: string) { if (!cond) throw new Error(msg || "Assertion failed"); },
        fail(msg: string) { throw new Error(msg || "Test failed explicitly"); },
        skip(msg: string = "Skipped") {
            console.log(`\x1b[33m[SKIP]\x1b[0m ${msg}`);
            throw new WebrunSkipError(msg);
        }
    };
}

export async function executeTestPayload(payload: SandboxContextPayload, contextPayload: any, preservedDeno: any) {
    const targetUrls = Array.isArray(payload.targetUrlHref) ? payload.targetUrlHref : [payload.targetUrlHref as string];
    const targetPaths = Array.isArray(payload.targetScriptPath) ? payload.targetScriptPath : [payload.targetScriptPath as string];

    const allTestExports: { name: string, fn: Function, scriptPath: string }[] = [];

    for (let i = 0; i < targetUrls.length; i++) {
        const url = targetUrls[i];
        const mod = await import(url);
        const scriptPath = targetPaths[i];
        const testExports = Object.entries(mod).filter(([k, v]) => k.startsWith("test") && typeof v === "function");
        for (const [name, fn] of testExports) {
            allTestExports.push({ name, fn: fn as Function, scriptPath });
        }
    }

    if (allTestExports.length === 0) {
        console.warn("[Webrun] No test exports found. Expected functions starting with 'test'.");
        preservedDeno.exit(0);
        return;
    }

    const webrunCtxMod = await import("webrun/ctx").catch(() => null);
    if (webrunCtxMod && webrunCtxMod.set) {
        webrunCtxMod.set(contextPayload);
    }

    for (const { name, fn, scriptPath } of allTestExports) {
        const cleanName = typeof name === 'string' ? (name.startsWith("test") ? name.substring(4).trim() : name) : String(name);
        preservedDeno.test({
            name: cleanName,
            sanitizeOps: false,
            sanitizeResources: false,
            sanitizeExit: false,
            async fn(stepCtx: any) {
                const guestT = createGuestTestContext(stepCtx);
                if (payload.isSelfTest) {
                    (guestT as any).Deno = preservedDeno;
                    (guestT as any).WORKER_BIN = payload.webrunBin;
                    (guestT as any).IS_REPACKED_TEST = payload.isRepackedTest;
                }
                try {
                    contextPayload.command = scriptPath;
                    await fn(guestT, contextPayload);
                } catch (err: any) {
                    if (err instanceof WebrunSkipError) {
                        return;
                    }
                    throw err;
                }
            }
        });
    }
}

export async function executeRunPayload(payload: SandboxContextPayload, contextPayload: any, preservedDeno: any) {
    contextPayload.command = payload.targetScriptPath as string;

    const webrunCtxMod = await import("webrun/ctx").catch(() => null);
    if (webrunCtxMod && webrunCtxMod.set) {
        webrunCtxMod.set(contextPayload);
    }

    const mod = await import(payload.targetUrlHref as string);
    const mainFn = typeof mod.default === 'function' ? mod.default : (mod.default && typeof mod.default.main === 'function' ? mod.default.main : null);
    if (mainFn) {
        await mainFn(contextPayload);
    }
    preservedDeno.exit(0);
}

const rewriteDenoError = (msg: string): string => {
    if (!msg) return msg;
    if (msg.includes("run again with the --allow-")) {
        return msg.replace(/, run again with the --allow-[a-z-]+ flag/g, "")
            + ".\n  Hint: Update the 'permissions' object in your webrun.json to allow this operation.";
    }
    return msg;
};

export function setupSandboxErrorHandlers(preservedDeno: any) {
    globalThis.addEventListener('unhandledrejection', (e: any) => {
        if (e.reason && e.reason.name === "WebrunSkipError") return;
        e.preventDefault();
        printExecutionError(rewriteDenoError(e.reason?.message || String(e.reason)));
        preservedDeno.exit(1);
    });

    globalThis.addEventListener('error', (e: any) => {
        e.preventDefault();
        printExecutionError(rewriteDenoError(e.error?.message || String(e.error)));
        preservedDeno.exit(1);
    });
}

export function setupMemoryMonitor(memoryMB: number, preservedDeno: any) {
    const MAX_RSS_BYTES = memoryMB * 1024 * 1024;
    const getMemoryUsage = preservedDeno.memoryUsage.bind(preservedDeno);
    setInterval(() => {
        const usage = getMemoryUsage();
        if (usage.rss > MAX_RSS_BYTES) {
            const currentMB = (usage.rss / 1024 / 1024).toFixed(2);
            printFatalError("Memory limit exceeded!", `Current: ${currentMB}MB / Allowed: ${memoryMB}MB`);
            preservedDeno.exit(137);
        }
    }, 500);
}

export async function executeInsideSandbox(payload: SandboxContextPayload) {
    const rawArgs = payload.injectedArgsObj;
    const argsPayload: string[] = [...rawArgs["--"]];
    const flags = { ...rawArgs };
    delete flags["--"];

    const storageManager = createStorageManager(payload.storageRoot, payload.fallbackToTemp);
    const opfsManager = createStorageManager(payload.opfsRoot, true);

    if (!(globalThis as any).navigator) {
        (globalThis as any).navigator = {};
    }
    (globalThis as any).navigator.storage = opfsManager;

    const preservedDeno = (globalThis as any).Deno;
    setupSandboxErrorHandlers(preservedDeno);

    if (payload.memoryMB) {
        setupMemoryMonitor(payload.memoryMB, preservedDeno);
    }

    delete (globalThis as any).Deno;

    try {
        const contextPayload = {
            args: argsPayload,
            flags: flags,
            env: payload.finalEnvVars,
            command: Array.isArray(payload.targetScriptPath) ? payload.targetScriptPath[0] : payload.targetScriptPath,
            argv: [payload.webrunBin, ...(payload.sandboxArgs || [])],
            dir: await storageManager.getDirectory(),
            persisted: !payload.fallbackToTemp
        };

        if (payload.action === "test") {
            await executeTestPayload(payload, contextPayload, preservedDeno);
        } else {
            await executeRunPayload(payload, contextPayload, preservedDeno);
        }
    } catch (err: any) {
        printExecutionError(rewriteDenoError(err.message));
        await new Promise(r => setTimeout(r, 10));
        preservedDeno.exit(1);
    }
}


export async function buildSandboxExecutionConfig(
    invocation: any,
    config: WebrunConfig,
    policy: any,
    projectRoot: string,
    isolatedTmp: string,
    runnerTmp: string,
    opfsTmp: string,
    localDenoDir: string,
    importMapPath: string,
    seatbeltProfile: string,
    lockFlag: string[],
    MAX_V8_MEM_MB: number
): Promise<{ baseCmd: string; cmdOptions: any }> {
    const resolveTargetUrl = (p: string) => p.startsWith("http") ? new URL(p).href : pathToFileURL(p).href;
    let targetUrlHref: string | string[];
    if (invocation.action === "eval") {
        targetUrlHref = `data:application/typescript;charset=utf-8,${encodeURIComponent(invocation.evalCode!)}`;
    } else {
        targetUrlHref = Array.isArray(invocation.targetScriptPath)
            ? invocation.targetScriptPath.map(resolveTargetUrl)
            : resolveTargetUrl(invocation.targetScriptPath as string);
    }

    const payloadObject: SandboxContextPayload = {
        action: invocation.action,
        isSelfTest: invocation.isSelfTest,
        webrunBin: sys.env.get("WEBRUN_BIN") || resolve(projectRoot, "webrun"),
        isRepackedTest: sys.env.get("WEBRUN_IS_REPACKED_TEST") === "1",
        storageRoot: policy.storageRoot,
        fallbackToTemp: policy.fallbackToTemp,
        injectedArgsObj: invocation.injectedArgsObj,
        finalEnvVars: computeRuntimeEnvironment(config.permissions?.env),
        targetUrlHref,
        targetScriptPath: invocation.targetScriptPath,
        evalCode: invocation.evalCode,
        sandboxArgs: invocation.sandboxArgs,
        opfsRoot: opfsTmp,
        memoryMB: config.limits?.memoryMB
    };

    const bootstrapPath = resolve(runnerTmp, "webrun_bootstrap.ts");
    const bootstrapCode = `import { executeInsideSandbox } from "${new URL(import.meta.url).href}";\nconst payload = ${JSON.stringify(payloadObject)};\nawait executeInsideSandbox(payload);\n`;
    sys.writeTextFileSync(bootstrapPath, bootstrapCode);

    const innerDenoArgs = [
        invocation.action === "eval" ? "run" : invocation.action,
        ...(invocation.isSelfTest ? [] : invocation.networkFlags),
        ...lockFlag,
        `--v8-flags=--max-old-space-size=${MAX_V8_MEM_MB}`,
        `--import-map=${importMapPath}`,
        "--no-prompt",
        "--no-npm",
        "--no-check"
    ];

    if (invocation.isSelfTest) {
        innerDenoArgs.push("-A");
    } else {
        const storageFlags = generateDenoStorageFlags(policy, isolatedTmp, runnerTmp, opfsTmp);
        innerDenoArgs.push(...storageFlags, `--allow-env=TMP_DIR`);
    }
    innerDenoArgs.push(bootstrapPath);

    const isMac = sys.build.os === "darwin" && !invocation.isSelfTest;
    const baseCmd = isMac ? "sandbox-exec" : sys.execPath();

    const execArgs = isMac ? [
        "-p", seatbeltProfile,
        "-D", `WEBRUN_SANDBOX_CACHE=${localDenoDir}`,
        "-D", `WEBRUN_ISOLATED_TMP=${isolatedTmp}`,
        "-D", `WEBRUN_DENO_JSON=${resolve(projectRoot, "deno.json")}`,
        "-D", `WEBRUN_DENO_JSONC=${resolve(projectRoot, "deno.jsonc")}`,
        "-D", `WEBRUN_DENO_LOCK=${lockFlag.length ? lockFlag[0].split('=')[1] : resolve(projectRoot, "deno.lock")}`,
        "-D", `WEBRUN_SCRIPT_PATH=${sys.realPathSync(new URL(import.meta.url).pathname)}`,
        "-D", `WEBRUN_DENO_BIN_DIR=${dirname(sys.execPath())}`,
        "-D", `WEBRUN_DENO_BIN_PATH=${sys.execPath()}`,
        sys.execPath(),
        ...innerDenoArgs
    ] : innerDenoArgs;

    const envVars = { ...payloadObject.finalEnvVars };
    if (invocation.isSelfTest) {
        envVars["WEBRUN_BIN"] = payloadObject.webrunBin;
        envVars["WEBRUN_IS_REPACKED_TEST"] = payloadObject.isRepackedTest ? "1" : "0";
        envVars["WEBRUN_DENO_DIR"] = dirname(sys.execPath());
    }

    const cmdOptions: any = {
        args: execArgs,
        env: {
            ...envVars,
            "HOME": isolatedTmp,
            "TMPDIR": isolatedTmp,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
            "USER": "sandbox",
            "DENO_DIR": localDenoDir,
            "TMP_DIR": isolatedTmp
        },
        clearEnv: true,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit"
    };

    if (config.limits?.timeoutMillis) {
        cmdOptions.signal = AbortSignal.timeout(config.limits.timeoutMillis);
    }

    return { baseCmd, cmdOptions };
}

export async function spawnSandboxProcess(cwd: string, args: string[]) {
    // 1. Setup Ephemeral Paths & Config
    const projectRoot = sys.realPathSync(cwd);
    const localDenoDir = (() => {
        const d = resolve(sys.env.get("HOME") || "/tmp", ".webrun_cache");
        sys.mkdirSync(d, { recursive: true });
        return sys.realPathSync(d);
    })();
    const isolatedTmp = sys.realPathSync(sys.makeTempDirSync({ prefix: 'sandbox_tmp_' }));
    const runnerTmp = sys.realPathSync(sys.makeTempDirSync({ prefix: 'webrun_runner_' }));
    const opfsTmp = sys.realPathSync(sys.makeTempDirSync({ prefix: 'webrun_opfs_' }));
    const { config, configDir, configFound, configPaths, importMapPaths } = resolveLocalConfiguration(cwd);

    const MAX_V8_MEM_MB = config.limits?.memoryMB || 512;

    // Version Check
    if (args.includes("--version") || args.includes("-v")) {
        console.log(`webrun ${sys.env.get("WEBRUN_VERSION") || "dev"}`);
        sys.exit(0);
    }

    // Help Command Evaluation
    if (args.includes("--help") || args.includes("-h")) {
        try {
            const selfPath = sys.env.get("WEBRUN_BIN") || resolve(projectRoot, "webrun");
            let readmeContent = sys.readTextFileSync(selfPath);
            if (readmeContent.match(/^__README_DATA__\s*$/m)) {
                readmeContent = readmeContent.split(/^__README_DATA__\s*$/m)[1].split(/^__LICENSE_DATA__\s*$/m)[0];
            } else {
                readmeContent = sys.readTextFileSync(resolve(dirname(selfPath), "README.md"));
            }
            console.log(`Usage: webrun [options] <script.ts> [args...]\n\nOptions:\n  -h, --help         Print the usage instructions\n  -e, --eval <code>  Evaluate the given code instead of reading from a file\n  --self-test        Run the built-in test suite to verify the sandbox is working correctly\n  --self-bundle      Package the webrun source files into a single executable file\n  --self-unbundle <dest>  Extract the webrun source files from the executable into a folder for editing\n  --test             Run the target script as a test suite instead of a standard program\n`);
            const contractMatch = readmeContent.match(/## API[^\n]*\n+([\s\S]*?)(\n## |$)/i);
            if (contractMatch && contractMatch[1]) {
                console.log("==========================================");
                console.log("WEBRUN API CONTRACT");
                console.log("==========================================");
                console.log(contractMatch[1].trim());
            }
        } catch (_) {
            printWarning("Documentation unavailable.");
        }
        sys.exit(0);
    }

    // 2. Parse Routing State
    const invocation = parseCommandInvocation(args, config);
    const policy = evaluateEnclavePolicy(config.permissions?.storage || {}, configDir, cwd, isolatedTmp);

    const protectedFiles: string[] = [...configPaths, ...importMapPaths];

    const binPath = tryRealpathSync(sys.env.get("WEBRUN_BIN") || resolve(projectRoot, "webrun"));
    if (binPath) protectedFiles.push(binPath);

    const selfPath = tryRealpathSync(new URL(import.meta.url).pathname);
    if (selfPath) protectedFiles.push(selfPath);

    const allowedWriteEnclaves = [isolatedTmp, ...policy.allowedWritePaths, opfsTmp];

    for (const allowed of allowedWriteEnclaves) {
        const canonicalAllowed = tryRealpathSync(allowed) || allowed;

        for (const rawProtectedFile of protectedFiles) {
            const protectedFile = tryRealpathSync(rawProtectedFile) || rawProtectedFile;

            if (protectedFile === canonicalAllowed || protectedFile.startsWith(canonicalAllowed + "/")) {
                printSecurityFatal("The webrun file is within a permitted write directory. Refusing to run.", {
                    Executable: protectedFile,
                    Permitted: canonicalAllowed
                });
                sys.exit(1);
            }
        }
    }

    if (!policy.isPwdAllowed && !policy.fallbackToTemp) {
        printSecurityFatal("The working directory is not granted read access in webrun.json storage permissions.", {
            Directory: cwd
        });
        sys.exit(1);
    }

    const importMapPath = buildNodeSinkholeDependencies(isolatedTmp, importMapPaths);

    // 3. Compile Security Vectors
    const { readEnclaves, writeEnclaves } = generateSeatbeltEnclaveStrings(policy, runnerTmp, opfsTmp);
    const seatbeltProfile = generateSeatbeltProfile(cwd, readEnclaves, writeEnclaves);

    const lockFlag: string[] = [];
    const lockFilePath = resolve(projectRoot, "deno.lock");
    if (tryStatSync(lockFilePath)?.isFile) lockFlag.push(`--lock=${lockFilePath}`);

    // 4. Assemble Process Image
    const { baseCmd, cmdOptions } = await buildSandboxExecutionConfig(
        invocation,
        config,
        policy,
        projectRoot,
        isolatedTmp,
        runnerTmp,
        opfsTmp,
        localDenoDir,
        importMapPath,
        seatbeltProfile,
        lockFlag,
        MAX_V8_MEM_MB
    );

    const cmd = new sys.Command(baseCmd, cmdOptions);

    try {
        const child = cmd.spawn();
        const status = await child.status;
        tryRemoveSync(isolatedTmp, { recursive: true });
        tryRemoveSync(runnerTmp, { recursive: true });
        tryRemoveSync(opfsTmp, { recursive: true });
        sys.exit(status.code);
    } catch (e: any) {
        tryRemoveSync(isolatedTmp, { recursive: true });
        tryRemoveSync(runnerTmp, { recursive: true });
        tryRemoveSync(opfsTmp, { recursive: true });
        if (e.name === "AbortError") {
            printExecutionError(`Timeout limit reached after ${config.limits?.timeoutMillis}ms`);
            sys.exit(143);
        }
        printExecutionError("Failed to spawn", e.message || String(e));
        sys.exit(1);
    }
}

// =========================================================
// 5. GLOBAL ENTRYPOINT EVALUATION
// =========================================================

if (import.meta.main) {
    await spawnSandboxProcess(sys.cwd(), sys.args);
}
