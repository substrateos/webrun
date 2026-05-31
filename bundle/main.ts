import * as esbuild from "https://deno.land/x/esbuild@v0.20.1/mod.js";
import { readTextFile } from "../src/core/io.ts";

interface BundleCtx {
    dir: FileSystemDirectoryHandle;
    resolveHandle(handle: FileSystemHandle): string;
}

/** Bundle webrun.ts into a single ESM file. Returns the bundled source as a string. */
export async function build(_args: string[], _env: Record<string, string>, ctx: BundleCtx): Promise<string> {
    const root = ctx.resolveHandle(ctx.dir);

    const httpToVendorPlugin = {
        name: "http-to-vendor",
        setup(build: any) {
            build.onResolve({ filter: /^https?:\/\// }, async (args: any) => {
                const url = new URL(args.path);
                const parts = [url.hostname, ...url.pathname.split("/").filter(Boolean)];
                let handle: FileSystemDirectoryHandle = await ctx.dir.getDirectoryHandle("vendor");
                for (const part of parts.slice(0, -1)) {
                    handle = await handle.getDirectoryHandle(part);
                }
                const fileHandle = await handle.getFileHandle(parts[parts.length - 1]);
                return { path: ctx.resolveHandle(fileHandle) };
            });
        }
    };

    const npmPlugin = {
        name: "npm-resolve",
        setup(build: any) {
            build.onResolve({ filter: /^npm:/ }, async (args: any) => {
                // npm:superjson@^2 → superjson
                // npm:@tauri-apps/plugin-shell@2.3.5 → @tauri-apps/plugin-shell
                const bare = args.path.slice(4); // remove "npm:"
                const name = bare.replace(/@[^/]*$/, ""); // remove @version
                const pkgJson = JSON.parse(await readTextFile(ctx.dir, ["node_modules", name, "package.json"]));
                const entry = pkgJson.module || pkgJson.main || "index.js";
                const nmHandle = await ctx.dir.getDirectoryHandle("node_modules");
                const pkgHandle = await nmHandle.getDirectoryHandle(name);
                return { path: `${ctx.resolveHandle(pkgHandle)}/${entry}` };
            });
        }
    };

    const result = await esbuild.build({
        entryPoints: ["webrun.ts"],
        write: false,
        bundle: true,
        format: "esm",
        platform: "node",
        target: "es2022",
        sourcemap: "inline",
        external: ["node:*"],
        nodePaths: [`${root}/node_modules`],
        plugins: [httpToVendorPlugin, npmPlugin],
        logLevel: "error",
    });

    if (result.errors.length > 0 || !result.outputFiles?.[0]) {
        throw new Error(`Bundle failed with ${result.errors.length} errors`);
    }
    return new TextDecoder().decode(result.outputFiles[0].contents);
}

async function main(args: string[], env: Record<string, string>, ctx: BundleCtx): Promise<void> {
    console.log(await build(args, env, ctx));
    esbuild.stop();
}

export default { main };

if (import.meta.main) {
    const createFS = (await import("../src/deno/file_system/mod.ts")).default;
    const fs = createFS(globalThis.Deno as any);
    const dir = new fs.FileSystemDirectoryHandle(Deno.cwd(), ".");
    const ctx: BundleCtx = { dir, resolveHandle: fs.resolveHandle };
    await main(Deno.args, Deno.env.toObject(), ctx);
}

