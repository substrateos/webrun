import { resolve, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

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
    action: "run" | "test";
    isSelfTest?: boolean;
    targetScriptPath: string | string[];
    sandboxArgs: string[];
    injectedArgsObj: Record<string, any>;
    networkFlags: string[];
}

export interface SandboxContextPayload {
    action: "run" | "test";
    isSelfTest?: boolean;
    webrunBin?: string;
    isRepackedTest?: boolean;
    storageRoot: string;
    fallbackToTemp: boolean;
    injectedArgsObj: Record<string, any>;
    finalEnvVars: Record<string, string>;
    targetUrlHref: string | string[];
    targetScriptPath: string | string[];
    sandboxArgs: string[];
    opfsRoot: string;
    memoryMB?: number;
}

// =========================================================
// 2. PURE: CONFIGURATION & PARSING
// =========================================================

export function parseCommandInvocation(args: string[], config: WebrunConfig): CommandInvocation {
    const rawArgs = [...args];
    let isTest = false;
    let isSelfTest = false;

    let targetScriptPath: string | string[] = "";
    const injectedArgsObj: Record<string, any> = { "--": [] };
    let onlyPositional = false;
    const testPaths: string[] = [];
    let scriptFound = false;

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

    if (rawArgs.length === 0 && !isTest) {
        printUsageError("Usage: webrun [options] <script.ts> [args...]\nRun with --help for documentation.");
        Deno.exit(1);
    }

    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i];
        if (onlyPositional) {
            if (isTest && !isSelfTest) {
                testPaths.push(arg);
            } else if (isSelfTest) {
                printSecurityFatal("The --self-test execution mode strictly forbids external file paths.");
                Deno.exit(1);
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
                Deno.exit(1);
            }
        }
    }

    if (isTest) {
        if (testPaths.length === 0) {
            printUsageError("Usage: webrun --test [options] <script1.ts> ... [args...]\nRun with --help for documentation.");
            Deno.exit(1);
        }
        targetScriptPath = testPaths;
    } else {
        if (!scriptFound) {
            printUsageError("Usage: webrun [options] <script.ts> [args...]\nRun with --help for documentation.");
            Deno.exit(1);
        }
    }

    const SSRF_BLOCK = "--deny-net=127.0.0.0/8,localhost,0.0.0.0/8,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,169.254.0.0/16";
    const networkFlags: string[] = [];
    const allowedDomains = config.permissions?.network || [];
    if (allowedDomains.length > 0) {
        networkFlags.push(`--allow-net=${allowedDomains.join(",")}`);
        networkFlags.push(SSRF_BLOCK);
    } else {
        networkFlags.push("--deny-net");
    }

    return {
        action: isTest ? "test" : "run",
        isSelfTest,
        targetScriptPath: targetScriptPath!,
        sandboxArgs: rawArgs,
        injectedArgsObj,
        networkFlags
    };
}

export function computeRuntimeEnvironment(allowedEnv: string[] = []): Record<string, string> {
    const finalEnvVars: Record<string, string> = {};
    for (const k of allowedEnv) {
        finalEnvVars[k] = Deno.env.get(k) || "";
    }
    return finalEnvVars;
}

export function computeStorageAccessPolicies(configDirs: Record<string, { access: "read" | "write" }>, configDir: string, currentDir: string, isolatedTmp: string) {
    let isPwdAllowed = false;
    let fallbackToTemp = false;

    if (Object.keys(configDirs).length === 0) {
        fallbackToTemp = true;
    }

    const denoReadAllow = [isolatedTmp];
    const denoWriteAllow = [isolatedTmp];
    let seatbeltReadEnclaves = ``;
    let seatbeltWriteEnclaves = ``;

    for (const [fsPath, settings] of Object.entries(configDirs)) {
        const absFsPath = resolve(configDir, fsPath);
        if (currentDir === absFsPath || currentDir.startsWith(absFsPath + "/")) {
            isPwdAllowed = true;
        }

        denoReadAllow.push(absFsPath);
        seatbeltReadEnclaves += `\n    (subpath "${absFsPath}")`;

        if (settings.access === "write") {
            denoWriteAllow.push(absFsPath);
            seatbeltWriteEnclaves += `\n    (subpath "${absFsPath}")`;
        }
    }

    if (fallbackToTemp) {
        denoReadAllow.push(currentDir);
        seatbeltReadEnclaves += `\n    (subpath "${currentDir}")`;
    }

    return {
        isPwdAllowed,
        fallbackToTemp,
        denoReadAllow,
        denoWriteAllow,
        seatbeltReadEnclaves,
        seatbeltWriteEnclaves,
        storageRoot: fallbackToTemp ? isolatedTmp : currentDir
    };
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

export function buildNodeSinkholeDependencies(isolatedTmp: string, importMapPaths: string[] = []): string {
    const sinkholeURI = "data:text/javascript,export default null; throw new Error('Security Error: Node/NPM modules are blocked.');";
    const importMapPayload: any = {
        imports: {
            "node:fs": sinkholeURI,
            "node:child_process": sinkholeURI,
            "node:net": sinkholeURI,
            "node:os": sinkholeURI,
            "node:path": sinkholeURI,
            "node:vm": sinkholeURI,
        },
        scopes: {}
    };

    for (const absMapPath of importMapPaths) {
        try {
            const userMap = JSON.parse(Deno.readTextFileSync(absMapPath));

            const rewriteToAbsolute = (obj: Record<string, string>) => {
                if (!obj) return;
                for (const [key, value] of Object.entries(obj)) {
                    if (value.startsWith("./") || value.startsWith("../")) {
                        let resolved = "file://" + resolve(dirname(absMapPath), value);
                        if (value.endsWith("/") && !resolved.endsWith("/")) resolved += "/";
                        obj[key] = resolved;
                    }
                }
            };

            if (userMap.imports) {
                rewriteToAbsolute(userMap.imports);
                Object.assign(importMapPayload.imports, userMap.imports);
            }

            if (userMap.scopes) {
                for (const [scopeKey, scopeValue] of Object.entries(userMap.scopes)) {
                    rewriteToAbsolute(scopeValue as any);
                    let resolvedScopeKey = scopeKey;
                    if (scopeKey.startsWith("./") || scopeKey.startsWith("../")) {
                        resolvedScopeKey = "file://" + resolve(dirname(absMapPath), scopeKey);
                        if (scopeKey.endsWith("/") && !resolvedScopeKey.endsWith("/")) {
                            resolvedScopeKey += "/";
                        }
                    }
                    if (!importMapPayload.scopes[resolvedScopeKey]) {
                        importMapPayload.scopes[resolvedScopeKey] = {};
                    }
                    Object.assign(importMapPayload.scopes[resolvedScopeKey], scopeValue);
                }
            }
        } catch (e: any) {
            printWarning(`Failed to parse or merge importMap at ${absMapPath}: ${e.message}`);
        }
    }

    const combinedPath = resolve(isolatedTmp, "sandbox_import_map.json");
    Deno.writeTextFileSync(combinedPath, JSON.stringify(importMapPayload));
    return combinedPath;
}

// =========================================================
// 3. PURE: WEB API VIRTUALIZATION
// =========================================================

export function createStorageManager(storageRoot: string, fallbackToTemp: boolean) {
    const localDeno = Deno;
    const { open, writeFile, readFile, stat, lstat, realPath } = localDeno;
    const resolvedStorageRoot = localDeno.realPathSync(storageRoot);

    async function enforceEnclave(target: string) {
        try {
            const linfo = await lstat(target);
            const rp = await realPath(target).catch(err => {
                if (err instanceof localDeno.errors.NotFound && linfo.isSymlink) {
                    throw new DOMException("Broken symlinks are not permitted.", "SecurityError");
                }
                throw err;
            });
            if (rp !== resolvedStorageRoot && !rp.startsWith(resolvedStorageRoot + "/")) {
                throw new DOMException("Path resolves outside enclave.", "SecurityError");
            }
        } catch (e: any) {
            if (!(e instanceof localDeno.errors.NotFound)) throw e;
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
                    await file.seek(pos, localDeno.SeekMode.Start);
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

    class File extends Blob {
        _path: string;
        _size: number;
        name: string;
        constructor(path: string, name: string, size: number) {
            super([]);
            this._path = path;
            this._size = size;
            this.name = name;
        }
        override get size() { return this._size; }
        override stream(): any {
            const ts = new TransformStream();
            enforceEnclave(this._path).then(() => open(this._path, { read: true })).then((file: any) => {
                file.readable.pipeTo(ts.writable).catch(() => { });
            });
            return ts.readable;
        }
        override async arrayBuffer() {
            await enforceEnclave(this._path);
            const data = await readFile(this._path);
            return data.buffer;
        }
        override async text() {
            await enforceEnclave(this._path);
            const data = await readFile(this._path);
            return new TextDecoder().decode(data);
        }
    }

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

    class FileSystemFileHandle extends FileSystemHandle {
        constructor(path: string, name: string) { super('file', path, name); }
        async createWritable(opts: { keepExistingData?: boolean } = {}) {
            await enforceEnclave(_getPath(this)!);
            const file = await open(_getPath(this)!, { write: true, create: true, truncate: !opts.keepExistingData });
            return new FileSystemWritableFileStream(file);
        }
        async getFile() {
            await enforceEnclave(_getPath(this)!);
            const meta = await stat(_getPath(this)!);
            return new File(_getPath(this)!, this.name, meta.size);
        }
    }

    class FileSystemDirectoryHandle extends FileSystemHandle {
        constructor(path: string, name: string) { super('directory', path, name); }
        async getFileHandle(name: string, opts: any = {}) {
            if (typeof name !== 'string' || name.includes("/") || name.includes(String.fromCharCode(92)) || name === ".." || name === ".") {
                throw new DOMException("Invalid file name.", "SecurityError");
            }
            const target = `${_getPath(this)!}/${name}`;
            await enforceEnclave(target);
            if (opts.create) {
                await writeFile(target, new Uint8Array(0), { create: true, append: true });
            } else {
                try {
                    const fi = await stat(target);
                    if (fi.isDirectory) throw new DOMException("Type mismatch.", "TypeMismatchError");
                } catch (err) {
                    if (err instanceof localDeno.errors.NotFound) throw new DOMException("The requested file could not be found.", "NotFoundError");
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
            await enforceEnclave(target);
            if (opts.create) {
                await localDeno.mkdir(target, { recursive: true });
            } else {
                try {
                    const fi = await stat(target);
                    if (!fi.isDirectory) throw new DOMException("Type mismatch.", "TypeMismatchError");
                } catch (err) {
                    if (err instanceof localDeno.errors.NotFound) throw new DOMException("The requested directory could not be found.", "NotFoundError");
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
            await enforceEnclave(target);
            try {
                await localDeno.remove(target, { recursive: !!opts.recursive });
            } catch (err) {
                if (err instanceof localDeno.errors.NotFound) {
                    throw new DOMException("The requested entry could not be found.", "NotFoundError");
                }
                throw err;
            }
        }
        async *entries() {
            const thisPath = _getPath(this)!;
            await enforceEnclave(thisPath);
            for await (const dirEntry of localDeno.readDir(thisPath)) {
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

    class StorageManager {
        async persisted() { return !fallbackToTemp; }
        async getDirectory() {
            return new FileSystemDirectoryHandle(storageRoot, "root");
        }
        async estimate() {
            return { quota: 0, usage: 0 };
        }
    }

    return new StorageManager();
}

// =========================================================
// 4. IMPURE: EXECUTION LIFECYCLES
// =========================================================

export function resolveLocalConfiguration(currentDir: string): { config: WebrunConfig, configDir: string, configFound: boolean, configPaths: string[], importMapPaths: string[] } {
    let configDir = currentDir;

    const allConfigs: { config: WebrunConfig, dir: string, path: string }[] = [];

    while (true) {
        const potentialWebrunPath = resolve(configDir, "webrun.json");
        const potentialPackagePath = resolve(configDir, "package.json");

        let foundConfig: any = null;
        let foundPath = "";

        try {
            if (Deno.statSync(potentialWebrunPath).isFile) {
                foundConfig = JSON.parse(Deno.readTextFileSync(potentialWebrunPath));
                foundPath = potentialWebrunPath;
            }
        } catch (_) { }

        if (!foundConfig) {
            try {
                if (Deno.statSync(potentialPackagePath).isFile) {
                    const pkgInfo = JSON.parse(Deno.readTextFileSync(potentialPackagePath));
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

    const importMapPaths: string[] = [];
    const finalConfig: WebrunConfig = { limits: { timeoutMillis: 120000, memoryMB: 512 }, permissions: { storage: {}, network: [], env: [] } };
    let finalConfigDir = currentDir;
    let configFound = false;

    if (allConfigs.length > 0) {
        configFound = true;
        const mostSpecific = allConfigs[0];
        finalConfigDir = mostSpecific.dir;

        // Verify subset rule up the tree
        for (let i = 0; i < allConfigs.length - 1; i++) {
            const childConfig = allConfigs[i].config;
            const childConfigDir = allConfigs[i].dir;
            const parentConfig = allConfigs[i + 1].config;
            const parentConfigDir = allConfigs[i + 1].dir;

            // Check limits
            if (parentConfig.limits) {
                if (parentConfig.limits.timeoutMillis !== undefined && childConfig.limits?.timeoutMillis !== undefined && childConfig.limits.timeoutMillis > parentConfig.limits.timeoutMillis) {
                    printSecurityFatal("Privilege escalation detected in nested configuration.", {
                        Reason: "Escalating 'timeoutMillis' limit",
                        Attempted: String(childConfig.limits.timeoutMillis),
                        Permitted: String(parentConfig.limits.timeoutMillis),
                        Child: childConfigDir,
                        Parent: parentConfigDir
                    });
                    Deno.exit(1);
                }
                if (parentConfig.limits.memoryMB !== undefined && childConfig.limits?.memoryMB !== undefined && childConfig.limits.memoryMB > parentConfig.limits.memoryMB) {
                    printSecurityFatal("Privilege escalation detected in nested configuration.", {
                        Reason: "Escalating 'memoryMB' limit",
                        Attempted: String(childConfig.limits.memoryMB),
                        Permitted: String(parentConfig.limits.memoryMB),
                        Child: childConfigDir,
                        Parent: parentConfigDir
                    });
                    Deno.exit(1);
                }
            }

            // Check env
            for (const e of childConfig.permissions!.env!) {
                if (!parentConfig.permissions!.env!.includes(e)) {
                    printSecurityFatal("Privilege escalation detected in nested configuration.", {
                        Reason: "Escalating 'env' permissions",
                        Attempted: e,
                        Child: childConfigDir,
                        Parent: parentConfigDir
                    });
                    Deno.exit(1);
                }
            }

            // Check network
            for (const n of childConfig.permissions!.network!) {
                if (!parentConfig.permissions!.network!.includes(n)) {
                    printSecurityFatal("Privilege escalation detected in nested configuration.", {
                        Reason: "Escalating 'network' permissions",
                        Attempted: n,
                        Child: childConfigDir,
                        Parent: parentConfigDir
                    });
                    Deno.exit(1);
                }
            }

            // Check storage
            const parentStorageAbs = Object.entries(parentConfig.permissions!.storage!).map(([k, v]: [string, any]) => ({ path: resolve(parentConfigDir, k), access: v.access }));
            const childStorageAbs = Object.entries(childConfig.permissions!.storage!).map(([k, v]: [string, any]) => ({ path: resolve(childConfigDir, k), access: v.access }));

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
                        Child: childConfigDir,
                        Parent: parentConfigDir
                    });
                    Deno.exit(1);
                }
            }
        }

        // Apply most specific config permissions
        Object.assign(finalConfig.permissions!, mostSpecific.config.permissions);

        // Collect all importMap paths from root down to child
        for (let i = allConfigs.length - 1; i >= 0; i--) {
            const cfg = allConfigs[i].config;
            if (cfg.importMap) {
                importMapPaths.push(resolve(allConfigs[i].dir, cfg.importMap));
            }
        }

        // Apply limits strictly narrowing from all levels
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

    const exitFn = Deno.exit;
    const testFn = Deno.test;
    const getMemoryUsage = Deno.memoryUsage.bind(Deno);

    if (payload.memoryMB) {
        const MAX_RSS_MB = payload.memoryMB;
        const MAX_RSS_BYTES = MAX_RSS_MB * 1024 * 1024;
        setInterval(() => {
            const usage = getMemoryUsage();
            if (usage.rss > MAX_RSS_BYTES) {
                const currentMB = (usage.rss / 1024 / 1024).toFixed(2);
                printFatalError("Memory limit exceeded!", `Current: ${currentMB}MB / Allowed: ${MAX_RSS_MB}MB`);
                exitFn(137);
            }
        }, 500);
    }

    const preservedDeno = (globalThis as any).Deno;
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
                console.warn("\x1b[33m[Webrun]\x1b[0m No test exports found. Expected functions starting with 'test'.");
                exitFn(0);
                return;
            }

            testFn({
                name: "[webrun] test suite",
                sanitizeOps: false,
                sanitizeResources: false,
                sanitizeExit: false,
                async fn(t: any) {
                    const grouped: Record<string, { name: string, fn: Function }[]> = {};
                    for (const { name, fn, scriptPath } of allTestExports) {
                        if (!grouped[scriptPath]) grouped[scriptPath] = [];
                        grouped[scriptPath].push({ name, fn });
                    }

                    for (const [scriptPath, exports] of Object.entries(grouped)) {
                        await t.step({
                            name: scriptPath,
                            sanitizeOps: false,
                            sanitizeResources: false,
                            sanitizeExit: false,
                            async fn(fileStepCtx: any) {
                                for (const { name, fn } of exports) {
                                    await fileStepCtx.step({
                                        name: typeof name === 'string' ? (name.startsWith("test") ? name.substring(4).trim() : name) : name,
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
                        });
                    }
                }
            });
        } else {
            contextPayload.command = payload.targetScriptPath as string;
            const mod = await import(payload.targetUrlHref as string);
            const mainFn = typeof mod.default === 'function' ? mod.default : (mod.default && typeof mod.default.main === 'function' ? mod.default.main : null);
            if (!mainFn) {
                throw new Error("Worker script must export a default function or an object containing a 'main' function.");
            }
            await mainFn(contextPayload);
            exitFn(0);
        }
    } catch (err: any) {
        printExecutionError(err.message);
        // Allow IPC pipe to flush stderr cleanly before exiting
        await new Promise(r => setTimeout(r, 10));
        exitFn(1);
    }
}


export async function spawnSandboxProcess(cwd: string, args: string[]) {
    // 1. Setup Ephemeral Paths & Config
    const projectRoot = Deno.realPathSync(cwd);
    const localDenoDir = await (async () => {
        const d = await import("https://deno.land/std@0.224.0/path/mod.ts").then(m => m.resolve(Deno.env.get("HOME") || "/tmp", ".webrun_cache"));
        Deno.mkdirSync(d, { recursive: true });
        return Deno.realPathSync(d);
    })();
    const isolatedTmp = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'sandbox_tmp_' }));
    const runnerTmp = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'webrun_runner_' }));
    const opfsTmp = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'webrun_opfs_' }));
    const { config, configDir, configFound, configPaths, importMapPaths } = resolveLocalConfiguration(cwd);

    const MAX_V8_MEM_MB = config.limits?.memoryMB || 512;

    // Version Check
    if (args.includes("--version") || args.includes("-v")) {
        console.log(`webrun ${Deno.env.get("WEBRUN_VERSION") || "dev"}`);
        Deno.exit(0);
    }

    // Help Command Evaluation
    if (args.includes("--help") || args.includes("-h")) {
        try {
            const selfPath = Deno.env.get("WEBRUN_BIN") || resolve(projectRoot, "webrun");
            let readmeContent = Deno.readTextFileSync(selfPath);
            if (readmeContent.match(/^__README_DATA__\s*$/m)) {
                readmeContent = readmeContent.split(/^__README_DATA__\s*$/m)[1].split(/^__LICENSE_DATA__\s*$/m)[0];
            } else {
                readmeContent = Deno.readTextFileSync(resolve(dirname(selfPath), "README.md"));
            }
            console.log(`Usage: webrun [options] <script.ts> [args...]\n\nOptions:\n  -h, --help         Print the usage instructions\n  --self-test         Run the built-in test suite to verify the sandbox is working correctly\n  --self-bundle <dest>    Package the webrun source files into a single executable file\n  --self-unbundle <dest>  Extract the webrun source files from the executable into a folder for editing\n  --test             Run the target script as a test suite instead of a standard program\n`);
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
        Deno.exit(0);
    }

    // 2. Parse Routing State
    const invocation = parseCommandInvocation(args, config);
    const policy = computeStorageAccessPolicies(config.permissions?.storage || {}, configDir, cwd, isolatedTmp);

    const protectedFiles: string[] = [...configPaths, ...importMapPaths];
    try { protectedFiles.push(Deno.realPathSync(Deno.env.get("WEBRUN_BIN") || resolve(projectRoot, "webrun"))); } catch (_) { }
    try { protectedFiles.push(Deno.realPathSync(new URL(import.meta.url).pathname)); } catch (_) { }

    for (const allowed of policy.denoWriteAllow) {
        let canonicalAllowed = allowed;
        try { canonicalAllowed = Deno.realPathSync(allowed); } catch (_) { }

        for (const rawProtectedFile of protectedFiles) {
            let protectedFile = rawProtectedFile;
            try { protectedFile = Deno.realPathSync(rawProtectedFile); } catch (_) { }

            if (protectedFile === canonicalAllowed || protectedFile.startsWith(canonicalAllowed + "/")) {
                printSecurityFatal("The webrun file is within a permitted write directory. Refusing to run.", {
                    Executable: protectedFile,
                    Permitted: canonicalAllowed
                });
                Deno.exit(1);
            }
        }
    }

    if (!policy.isPwdAllowed && !policy.fallbackToTemp) {
        printSecurityFatal("The working directory is not granted read access in webrun.json storage permissions.", {
            Directory: cwd
        });
        Deno.exit(1);
    }

    const importMapPath = buildNodeSinkholeDependencies(isolatedTmp, importMapPaths);

    // 3. Compile Security Vectors
    const seatbeltReadEnclaves = policy.seatbeltReadEnclaves + `\n    (subpath "${runnerTmp}")`;
    const seatbeltWriteEnclaves = policy.seatbeltWriteEnclaves + `\n    (subpath "${opfsTmp}")`;
    const seatbeltProfile = generateSeatbeltProfile(cwd, seatbeltReadEnclaves, seatbeltWriteEnclaves);

    const lockFlag = [];
    const lockFilePath = resolve(projectRoot, "deno.lock");
    try {
        if (Deno.statSync(lockFilePath).isFile) lockFlag.push(`--lock=${lockFilePath}`);
    } catch (_) { }

    // 4. Assemble Process Image
    const resolveTargetUrl = async (p: string) => p.startsWith("http") ? new URL(p).href : new URL(await import("node:url").then(m => m.pathToFileURL(p))).href;
    const targetUrlHref = Array.isArray(invocation.targetScriptPath)
        ? await Promise.all(invocation.targetScriptPath.map(resolveTargetUrl))
        : await resolveTargetUrl(invocation.targetScriptPath as string);

    const payloadObject: SandboxContextPayload = {
        action: invocation.action,
        isSelfTest: invocation.isSelfTest,
        webrunBin: Deno.env.get("WEBRUN_BIN") || resolve(projectRoot, "webrun"),
        isRepackedTest: Deno.env.get("WEBRUN_IS_REPACKED_TEST") === "1",
        storageRoot: policy.storageRoot,
        fallbackToTemp: policy.fallbackToTemp,
        injectedArgsObj: invocation.injectedArgsObj,
        finalEnvVars: computeRuntimeEnvironment(config.permissions?.env),
        targetUrlHref,
        targetScriptPath: invocation.targetScriptPath,
        sandboxArgs: invocation.sandboxArgs,
        opfsRoot: opfsTmp,
        memoryMB: config.limits?.memoryMB
    };

    const bootstrapPath = resolve(runnerTmp, "webrun_bootstrap.ts");
    const bootstrapCode = `import { executeInsideSandbox } from "${new URL(import.meta.url).href}";
const payload = ${JSON.stringify(payloadObject)};
await executeInsideSandbox(payload);
`;
    Deno.writeTextFileSync(bootstrapPath, bootstrapCode);

    const innerDenoArgs = [
        invocation.action,
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
        innerDenoArgs.push(
            `--allow-read=${policy.denoReadAllow.join(",")},${runnerTmp},${opfsTmp}`,
            `--allow-write=${policy.denoWriteAllow.join(",")},${opfsTmp}`,
            `--allow-env=TMP_DIR`
        );
    }
    innerDenoArgs.push(bootstrapPath);

    const isMac = Deno.build.os === "darwin" && !invocation.isSelfTest;
    const baseCmd = isMac ? "sandbox-exec" : Deno.execPath();

    const execArgs = isMac ? [
        "-p", seatbeltProfile,
        "-D", `WEBRUN_SANDBOX_CACHE=${localDenoDir}`,
        "-D", `WEBRUN_ISOLATED_TMP=${isolatedTmp}`,
        "-D", `WEBRUN_DENO_JSON=${resolve(projectRoot, "deno.json")}`,
        "-D", `WEBRUN_DENO_JSONC=${resolve(projectRoot, "deno.jsonc")}`,
        "-D", `WEBRUN_DENO_LOCK=${lockFilePath}`,
        "-D", `WEBRUN_SCRIPT_PATH=${Deno.realPathSync(new URL(import.meta.url).pathname)}`,
        "-D", `WEBRUN_DENO_BIN_DIR=${dirname(Deno.execPath())}`,
        "-D", `WEBRUN_DENO_BIN_PATH=${Deno.execPath()}`,
        Deno.execPath(),
        ...innerDenoArgs
    ] : innerDenoArgs;

    const envVars = { ...payloadObject.finalEnvVars };
    if (invocation.isSelfTest) {
        envVars["WEBRUN_BIN"] = payloadObject.webrunBin;
        envVars["WEBRUN_IS_REPACKED_TEST"] = payloadObject.isRepackedTest ? "1" : "0";
        envVars["WEBRUN_DENO_DIR"] = dirname(Deno.execPath());
    }

    const cmdOptions: Deno.CommandOptions = {
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

    const cmd = new Deno.Command(baseCmd, cmdOptions);

    try {
        const child = cmd.spawn();
        const status = await child.status;
        try { Deno.removeSync(isolatedTmp, { recursive: true }); } catch (_) { }
        try { Deno.removeSync(runnerTmp, { recursive: true }); } catch (_) { }
        try { Deno.removeSync(opfsTmp, { recursive: true }); } catch (_) { }
        Deno.exit(status.code);
    } catch (e: any) {
        try { Deno.removeSync(isolatedTmp, { recursive: true }); } catch (_) { }
        try { Deno.removeSync(runnerTmp, { recursive: true }); } catch (_) { }
        try { Deno.removeSync(opfsTmp, { recursive: true }); } catch (_) { }
        if (e.name === "AbortError") {
            printExecutionError(`Timeout limit reached after ${config.limits?.timeoutMillis}ms`);
            Deno.exit(143);
        }
        printExecutionError("Failed to spawn", e.message || String(e));
        Deno.exit(1);
    }
}

// =========================================================
// 5. GLOBAL ENTRYPOINT EVALUATION
// =========================================================

if (import.meta.main) {
    await spawnSandboxProcess(Deno.cwd(), Deno.args);
}
