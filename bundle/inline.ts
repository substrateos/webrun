/**
 * Inline bundler — bundles a TS entrypoint with esbuild and emits
 * a JS module that exports the code as a blob URL.
 *
 * Usage: deno run -A bundle/inline.ts [--raw] <entrypoint>
 * Output goes to stdout.
 */
import * as esbuild from "https://deno.land/x/esbuild@v0.20.1/mod.js";
import { join } from "https://deno.land/std@0.220.1/path/mod.ts";
import { readTextFile } from "../src/core/io.ts";

interface BundleCtx {
    dir: FileSystemDirectoryHandle;
    resolveHandle(handle: FileSystemHandle): string;
}

function rewriteNodeImports(code: string): string {
    const importRegex = /import\s+\{\s*([\s\S]+?)\s*\}\s+from\s+["'](node:[^"']+)["'];/g;
    const counters: Record<string, number> = {};
    return code.replace(importRegex, (_match, importsStr, moduleSpecifier) => {
        counters[moduleSpecifier] = (counters[moduleSpecifier] || 0) + 1;
        const safeName = "__node_" + moduleSpecifier.replace(/[^a-zA-Z0-9]/g, "_") + "_" + counters[moduleSpecifier];
        const bindings = importsStr.split(",").map((s: string) => s.trim()).filter(Boolean);
        const declarations = bindings.map((b: string) => {
            const parts = b.split(/\s+as\s+/);
            const local = parts[parts.length - 1];
            const imported = parts[0];
            return `const ${local} = ${safeName}.${imported};`;
        }).join(" ");
        return `import * as ${safeName} from "${moduleSpecifier}"; ${declarations}`;
    });
}

export async function build(entrypoint: string, ctx: BundleCtx): Promise<string> {
    const root = ctx.resolveHandle(ctx.dir);
    const vendorDir = join(root, "vendor");

    const denoVendorPlugin: esbuild.Plugin = {
        name: "deno-vendor",
        setup(build) {
            build.onResolve({ filter: /^https?:\/\// }, (args) => {
                const url = new URL(args.path);
                const vendorPath = join(vendorDir, url.host, ...url.pathname.split("/").filter(Boolean));
                return { path: vendorPath };
            });

            build.onResolve({ filter: /^npm:/ }, async (args) => {
                const bare = args.path.replace(/^npm:/, "").replace(/@[^/]*$/, "");
                const pkgJson = JSON.parse(await readTextFile(ctx.dir, ["node_modules", bare, "package.json"]));
                const entry = pkgJson.module || pkgJson.main || "index.js";
                const pkgHandle = await ctx.dir.getDirectoryHandle("node_modules")
                    .then(h => h.getDirectoryHandle(bare));
                return { path: join(ctx.resolveHandle(pkgHandle), entry) };
            });

            build.onResolve({ filter: /^jsr:/ }, async (args) => {
                const stripped = args.path.replace(/^jsr:/, "");
                const match = stripped.match(/^(@[^/]+\/[^@]+)@([^/]+)(\/.*)?$/);
                if (!match) throw new Error(`Cannot parse JSR specifier: ${args.path}`);
                const [, name, version, subpath] = match;
                const exportKey = subpath || ".";

                const metaPath = ["vendor", "jsr.io", ...name.split("/"), `${version}_meta.json`];
                const meta = JSON.parse(await readTextFile(ctx.dir, metaPath));
                const exports: Record<string, string> = meta.exports || {};
                const entry = exports[exportKey];
                if (!entry) throw new Error(`No export '${exportKey}' in ${metaPath.join("/")}`);

                return { path: join(vendorDir, "jsr.io", name, version, entry) };
            });
        },
    };

    const result = await esbuild.build({
        entryPoints: [entrypoint],
        write: false,
        bundle: true,
        format: "esm",
        platform: "node",
        target: "es2022",
        external: ["node:*"],
        nodePaths: [join(root, "node_modules")],
        plugins: [denoVendorPlugin],
        logLevel: "error",
    });

    if (result.errors.length > 0 || !result.outputFiles?.[0]) {
        throw new Error(`Bundle failed (${entrypoint}): ${result.errors.length} errors`);
    }

    let code = result.outputFiles[0].text;
    return rewriteNodeImports(code);
}

async function main(args: string[], _env: Record<string, string>, ctx: BundleCtx): Promise<void> {
    const entrypoint = args.find(arg => !arg.startsWith("--"));
    if (!entrypoint) throw new Error("Usage: bundle/inline.ts <entrypoint>");
    console.log(await build(entrypoint, ctx));
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
