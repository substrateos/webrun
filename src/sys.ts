// NOTE: We use absolute URLs for dependencies instead of deno.json import maps
// because this module is dynamically evaluated inside restricted Deno Workers.
// Worker instances do not automatically inherit the host's import map, and
// bare specifiers would fail to resolve without 'deno bundle'.
import { resolve, dirname, extname, join, globToRegExp, normalize, isAbsolute } from "https://deno.land/std@0.224.0/path/mod.ts";
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

export function tryRealpathSync(p: string): string | undefined {
    try { return sys.realPathSync(p); } catch { return undefined; }
}

export function tryRemoveSync(p: string, options?: { recursive?: boolean }): void {
    try { sys.removeSync(p, options); } catch { /* Ignored */ }
}

export function tryStatSync(p: string): { isFile: boolean, isDirectory: boolean, isSymlink: boolean } | undefined {
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

