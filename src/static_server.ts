/**
 * Runtime capabilities needed by the static file server.
 * Narrow subset of ServeRuntime — only file-reading.
 */
interface StaticServerRuntime {
    readFileSync(path: string | URL): Uint8Array;
}

// Unix-compatible path helpers to avoid std/path remote dependency in guest
function dirname(path: string): string {
    const idx = path.lastIndexOf("/");
    if (idx === -1) return ".";
    if (idx === 0) return "/";
    return path.slice(0, idx);
}

function join(root: string, finalPath: string): string {
    const r = root.endsWith("/") ? root.slice(0, -1) : root;
    const f = finalPath.startsWith("/") ? finalPath : "/" + finalPath;
    return r + f;
}

function extname(path: string): string {
    const base = path.substring(path.lastIndexOf("/") + 1);
    const idx = base.lastIndexOf(".");
    if (idx === -1 || idx === 0) return "";
    return base.substring(idx);
}

const MIME_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
};

function getContentType(ext: string): string {
    return MIME_TYPES[ext] || "application/octet-stream";
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
            const cType = getContentType(ext);
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
