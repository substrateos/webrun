import { buildRunFn } from "../run/mod.ts";
import { SharedRegistry } from "../../core/run/shared_registry.ts";
import type { ContextDescriptor, WorkerContext } from "../../core/ipc.ts";
import { resolveStoragePaths } from "../../core/types.ts";

const isSandboxEntrypoint = (args: string[]) => args[0] === "--internal-webrun-sandbox";

/**
 * Unified sandbox entrypoint.
 *
 * 1. Reads the ContextDescriptor from a temp file (path in args[1]).
 * 2. Applies the OS-level jail (seatbelt/landlock) from descriptor.caps.
 * 3. Revokes jail-only Deno permissions (descriptor.drop).
 * 4. Binary mode: exec the binary.
 * 5. Module mode: create a Worker with explicit permissions, run the module.
 *
 * ctx.run() and ctx.serve() are handled directly by the sandbox —
 * no IPC proxy to a host process.
 */
const executeSandbox = async (args: string[], env: Record<string, string>, ctx: any) => {
    // Read descriptor from temp file, then delete it immediately.
    const descriptorPath = args[1];
    if (!descriptorPath) throw new Error("Missing descriptor path argument");
    const Deno = ctx.Deno;
    const descriptorJson = ctx.Deno.readTextFileSync(descriptorPath);
    const descriptor: ContextDescriptor = JSON.parse(descriptorJson);
    Deno.removeSync(descriptorPath);

    // 2. Apply OS-level sandbox.
    await ctx.applyJail(descriptor);

    // 3. Dispatch by mode.
    if (descriptor.mode === 'binary') {
        const { command, args } = descriptor.binary!;
        return ctx.exec(command, ...args);
    }

    // Module mode — run in-process via Worker.
    const mod = descriptor.module!;

    const worker = await ctx.createWorker(descriptor);

    const fs = ctx.fs;
    const projectDir = mod.fs.dir || Deno.cwd();

    // Extension config does not inherit from parent to child.
    const { extensions: _, ...childConfig } = mod.config;

    // Pre-resolve child config storage paths to absolute against the project dir.
    if (childConfig.permissions?.storage) {
        childConfig.permissions = {
            ...childConfig.permissions,
            storage: resolveStoragePaths(childConfig.permissions.storage, projectDir),
        };
    }

    const getPath = (h: FileSystemDirectoryHandle | FileSystemFileHandle): string => {
        const p = fs.resolveHandle(h);
        if (!p) throw new Error("Unrecognized handle: cannot extract path");
        return p;
    };

    const sharedRegistry = new SharedRegistry();

    const deps = {
        Deno: Deno,
        fs,
        tempDir: mod.fs.tempDir,
        dataDir: mod.fs.dataDir,
        cacheDir: mod.fs.cacheDir,
        spawn: await ctx.ipc.connectSpawner(descriptor.host, Deno),
        host: descriptor.host,
        sharedRegistry,
    };

    // Ceiling: pre-resolve storage to absolute, add parent temp dir as writable.
    const ceilingPerms = { ...(mod.config.permissions || {}) };
    const ceilingStorage = resolveStoragePaths(ceilingPerms.storage || {}, projectDir);
    // The parent's temp dir is inherently writable (ctx.makeTempDir, child temp roots).
    // Include it so children running in temp dirs can declare storage.
    if (mod.fs.tempDir) {
        ceilingStorage[mod.fs.tempDir] = { access: "write" };
    }
    ceilingPerms.storage = ceilingStorage;
    const ceiling = {
        permissions: ceilingPerms,
        limits: mod.config.limits || {},
        isolate: (mod.config as any).isolate || [],
    };

    // The parent's run function — used for the initial module execution.
    // Built without locations since the parent context is pre-resolved.
    const run = buildRunFn(deps, {
        aliases: mod.aliases || {},
        config: childConfig,
        protectedPaths: mod.protectedPaths || [],
        importMap: mod.importMap || { imports: {}, scopes: {} },
        dir: projectDir,
    }, ceiling);

    // ctx.run() handler: discover child configs and create a fresh buildRunFn.
    // Follows the same flow as the host (host.ts): discover → aliases → context → run.
    const childRun = async (runArgs: string[], options?: any) => {
        // Forward dirRoot/dirPath if present from the worker's file_system extension.
        // Otherwise compute from known roots so buildRunFn can discover configs.
        if (!options?.dirRoot) {
            const childDir = options?.dir || projectDir;
            let rootPath: string;
            let relParts: string[];
            if (childDir.startsWith(projectDir + "/") || childDir === projectDir) {
                rootPath = projectDir;
                relParts = childDir === projectDir ? [] : childDir.slice(projectDir.length + 1).split("/");
            } else if (mod.fs.tempDir && childDir.startsWith(mod.fs.tempDir + "/")) {
                rootPath = mod.fs.tempDir;
                relParts = childDir.slice(mod.fs.tempDir.length + 1).split("/");
            } else {
                rootPath = childDir;
                relParts = [];
            }
            options = { ...options, dirRoot: rootPath, dirPath: relParts };
        }
        return run(runArgs, options);
    };

    const workerAPI = await ctx.ipc.connectWorker(worker, {
        exit: (code?: number) => ctx.exit(code ?? 0),
        run: childRun,
        onAbort: (callback: () => void) => ctx.signal.addEventListener("abort", () => callback(), { once: true }),
        tty: ctx.tty,
    });
    const ports: Record<string, MessagePort> = {};
    if (childConfig.permissions?.webrtc) {
        const { default: makeUdpRelay } = await import("../extensions/webrtc/udp_relay.ts");
        const relay = makeUdpRelay({ listenDatagram: ctx.Deno.listenDatagram });
        ports["@webrun/deno/webrtc"] = relay.port1;
        ctx.signal.addEventListener("abort", relay.cleanup, { once: true });
    }

    await workerAPI.init(descriptor, ctx.stdio, ports)

    await new Promise((_, reject) => {
        worker.onerror = (e: any) => reject(e.error ?? e);
    });
}

const sandbox = {
    main: async (args: string[], env: Record<string, string>, ctx: any) => {
        if (isSandboxEntrypoint(args)) {
            return await executeSandbox(args, env, ctx)
        }

        throw new Error(`Unknown entrypoint: ${args[0]}`)
    }
}

export default sandbox
