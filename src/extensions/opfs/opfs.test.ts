import opfs from "./mod.ts";
import type { Context, ExtensionContext } from "../../core/types.ts";

class MockWritable implements FileSystemWritableFileStream {
    locked = false;
    async abort() {}
    async close() {}
    getWriter(): WritableStreamDefaultWriter<any> { throw new Error("unimplemented"); }
    async write() {}
    async seek() {}
    async truncate() {}
}

class MockSyncAccessHandle implements FileSystemSyncAccessHandle {
    close() {}
    flush() {}
    getSize() { return 0; }
    read(buffer: AllowSharedBufferSource, options?: { at?: number }) { return 0; }
    truncate(newSize: number) {}
    write(buffer: AllowSharedBufferSource, options?: { at?: number }) { return 0; }
}

class MockFile implements FileSystemFileHandle {
    kind = "file" as const;
    constructor(public name: string) {}
    isSameEntry = async () => false;
    getFile = async () => new File([""], this.name);
    createWritable = async () => new MockWritable();
    createSyncAccessHandle = async () => new MockSyncAccessHandle();
}

class MockDir implements FileSystemDirectoryHandle {
    kind = "directory" as const;
    constructor(
        public name: string,
        public onGetDir?: (name: string) => Promise<FileSystemDirectoryHandle>,
        public onGetFile?: (name: string) => Promise<FileSystemFileHandle>
    ) {}
    isSameEntry = async () => false;
    getFileHandle = async (name: string, options?: { create?: boolean }) => this.onGetFile ? this.onGetFile(name) : new MockFile(name);
    getDirectoryHandle = async (name: string, options?: { create?: boolean }) => this.onGetDir ? this.onGetDir(name) : new MockDir(name);
    removeEntry = async () => {};
    resolve = async () => null;
    async *keys(): AsyncIterableIterator<string> { yield "temp_file.txt"; }
    async *values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle> {}
    async *entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]> {}
    [Symbol.asyncIterator]() { return this.entries(); }
}

class MockContext implements ExtensionContext {
    argv = [];
    args = [];
    flags = {};
    env = {};
    location = "";
    meta = { url: "", cwd: "", resolve: (s: string) => s };
    extensionKey = "@webrun/opfs";
    dir = new MockDir("app_dir");
    extensions = {};
    makeTempDir = async () => new MockDir("temp_dir");
    extensionData = async () => ({
        dir: new MockDir("opfs_ext", async (subName) =>
            new MockDir(subName, async (leafName) =>
                new MockDir(leafName, undefined, async (fileName) => new MockFile(fileName))
            )
        ),
        hashForFileSystemHandle: async () => "mocked_hash",
    });
    createFileSystemHandleURL = () => "";
    serve: ExtensionContext["serve"] = async () => { throw new Error("unimplemented"); };
    TCPSocket = class {} as any;
    run: ExtensionContext["run"] = Object.assign(async () => { throw new Error(); }, { unref: () => {} }) as any;
    signal = new AbortController().signal;
    stdin = null;
    stdout = null;
    stderr = null;
    tty = null;
    exit = (code: number): never => { throw new Error("exit " + code); };
}

function mockCtx(): ExtensionContext {
    return new MockContext();
}

export async function testOpfs(t: any) {
    const cases = [
        {
            name: "ephemeral strategy (default)",
            config: {},
            expectEphemeral: true,
            expectHandleName: "temp_dir",
        },
        {
            name: "path strategy",
            config: { origin: "path" },
            expectEphemeral: false,
            expectHandleName: "fs",
        },

    ];

    for (const tc of cases) {
        await t.run(`opfs: ${tc.name}`, async () => {
            const ctx = mockCtx();
            let extendedCtx: any;
            await opfs(ctx, async (nextCtx) => {
                extendedCtx = nextCtx;
            }, tc.config);

            const opfsConfig = extendedCtx.extensions["@webrun/opfs"];
            if (!opfsConfig) throw new Error("Missing opfs config in extensions");
            if (opfsConfig.isEphemeral !== tc.expectEphemeral) {
                throw new Error(`Expected isEphemeral=${tc.expectEphemeral}, got ${opfsConfig.isEphemeral}`);
            }
            if (opfsConfig.navigatorStorageDirectory.name !== tc.expectHandleName) {
                throw new Error(`Expected directory handle name '${tc.expectHandleName}', got '${opfsConfig.navigatorStorageDirectory.name}'`);
            }
        });
    }
}
