import { join, dirname, extname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { contentType } from "https://deno.land/std@0.224.0/media_types/mod.ts";

/**
 * Runtime capabilities needed by the static file server.
 * Narrow subset of ServeRuntime — only file-reading.
 */
interface StaticServerRuntime {
    readFileSync(path: string | URL): Uint8Array;
}

/**
 * Creates a fetch handler that serves static files from a directory.
 *
 * Security: rejects paths containing ".." to prevent traversal.
 * Resolution: if targetPath is a file, serves from its parent directory.
 */
export function createStaticHandler(
    sys: StaticServerRuntime,
    targetPath: string,
    isDir: boolean,
): (req: Request) => Response {
    const root = isDir ? targetPath : dirname(targetPath);

    return (req: Request): Response => {
        const url = new URL(req.url);
        let finalPath = url.pathname;
        if (finalPath.endsWith("/")) finalPath += "index.html";

        if (finalPath.includes("..")) {
            return new Response("Forbidden", { status: 403 });
        }

        try {
            const absolutePath = join(root, finalPath);
            const ext = extname(absolutePath).toLowerCase();
            const cType = contentType(ext) || "application/octet-stream";
            const file = sys.readFileSync(absolutePath);
            return new Response(file as BodyInit, { headers: { "Content-Type": cType } });
        } catch (err: any) {
            if (err.name === "NotFound") return new Response("Not Found", { status: 404 });
            return new Response(err.message, { status: 500 });
        }
    };
}

/**
 * Creates a JavaScript shim response that re-exports a module.
 * Used when a single script file is served at "/" without a fetch handler.
 */
export function createModuleShimHandler(targetFilename: string): () => Response {
    const shim = `export * from "./${targetFilename}";\nimport * as mod from "./${targetFilename}";\nexport default mod.default;`;
    return () => new Response(shim, { headers: { "Content-Type": "text/javascript" } });
}
