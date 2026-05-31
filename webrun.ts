const webrun = {
    main: async function (args: string[], env: Record<string, string>, ctx: any) {
        if (args[0]?.startsWith("--internal-webrun-sandbox")) {
            const SandboxAdapter = await import("./src/deno/sandbox/mod.ts");
            try {
                await SandboxAdapter.default.main(args, env, ctx);
            } catch (e) {
                const { printExecutionErrorWithStack } = await import("./src/core/log.ts");
                printExecutionErrorWithStack(e);
                ctx.Deno.exit(1);
            }
        } else if (args[0] === "--internal-webrun-spawner") {
            const SpawnerModule = await import("./src/deno/spawner/mod.ts");
            await SpawnerModule.default.main(args.slice(1), env, ctx);
        } else if (args[0] === "--internal-webrun-proxy") {
            const ProxyModule = await import("./src/ua_proxy/main.ts");
            await ProxyModule.default.main(args.slice(1), env, ctx);
        } else {
            const HostAdapter = await import("./src/deno/host/host.ts")
            await HostAdapter.default.main(args, env, ctx);
        }
    }
}

export default webrun

if (import.meta.main) {
    const makeSignal = (await import("./src/deno/sandbox/signal.ts")).default;
    const makeFS = (await import("./src/deno/file_system/mod.ts")).default;
    const makeExec = (await import("./src/deno/jail/exec/mod.ts")).default;
    const makeTTY = (await import("./src/deno/sandbox/tty.ts")).default;
    const makeStdIO = (await import("./src/deno/worker/stdio.ts")).default;

    const ctx = {
        Deno,
        ipc: {
            connectWorker: async (worker: Worker, ctx: any) => {
                const { connectWorker } = await import("./src/ipc/worker.ts");
                return connectWorker(worker, ctx);
            },
            connectSpawner: async (host: any, deno: any) => {
                const { connectSpawner } = await import("./src/ipc/spawner.ts");
                return connectSpawner(host, deno);
            },
        },
        applyJail: async (descriptor: any) => {
            const os = Deno.build.os;
            if (os === "darwin") {
                const { toSeatbeltPolicy } = await import("./src/core/jail/seatbelt/mod.ts");
                const { makeSeatbelt } = await import("./src/deno/jail/seatbelt/mod.ts");
                const { applySeatbelt } = makeSeatbelt(Deno);
                applySeatbelt(toSeatbeltPolicy(descriptor.caps));
            } else if (os === "linux") {
                const { toLandlockPolicy } = await import("./src/core/jail/landlock/mod.ts");
                const { makeLandlock } = await import("./src/deno/jail/landlock/mod.ts");
                const { applyLandlock } = makeLandlock(Deno);
                applyLandlock(toLandlockPolicy(descriptor.caps));
            } else {
                throw new Error("Unsupported OS: " + os);
            }
            const { revokePermissions } = await import("./src/deno/jail/mod.ts");
            await revokePermissions(descriptor.drop);
        },
        signal: makeSignal(Deno),
        fs: makeFS(Deno),
        exit: (code: number) => Deno.exit(code),
        exec: makeExec(Deno),
        createWorker: async (descriptor: any) => {
            const { applyDrop } = await import("./src/core/capabilities.ts");
            const { toDenoPermissionsObject } = await import("./src/deno/jail/mod.ts");
            const workerPath = descriptor.host?.bundle?.workerPath;
            if (!workerPath) throw new Error("WEBRUN_WORKER not set — cannot locate worker blob");
            const workerEntrypointURL = new URL(workerPath, "file:///").href;
            const guestCaps = applyDrop(descriptor.caps, descriptor.drop);
            const permissions = toDenoPermissionsObject(guestCaps);
            return new Worker(workerEntrypointURL, {
                type: "module",
                name: "webrun-main",
                deno: { permissions },
            });
        },
        tty: makeTTY(Deno),
        stdio: makeStdIO(Deno),
    };
    const env: Record<string, string> = new Proxy(Object.create(null), {
        get: (_, key: string) => Deno.env.get(key),
    });
    await webrun.main(Deno.args, env, ctx)
}
