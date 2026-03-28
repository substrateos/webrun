import type { SandboxContextPayload, ServeRuntime } from "./types.ts";
import { join, dirname, extname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { contentType } from "https://deno.land/std@0.224.0/media_types/mod.ts";

export async function executeServePayload(sys: ServeRuntime, payload: SandboxContextPayload, contextPayload: any) {
    contextPayload.command = payload.targetScriptPath;

    const webrunCtxMod = await import("webrun/ctx").catch(() => null);
    if (webrunCtxMod && webrunCtxMod.set) {
        webrunCtxMod.set(contextPayload);
    }
    
    let isDir = false;
    if (payload.targetUrlHref.startsWith("file://")) {
        try {
            const pathUrl = new URL(payload.targetUrlHref);
            let pathStr = decodeURIComponent(pathUrl.pathname);
            if (sys.build.os === "windows" && pathStr.startsWith("/")) {
                pathStr = pathStr.slice(1);
            }
            try {
                // Use async stat — statSync internally references the runtime global
                // which has been deleted in the guest context. The async variant works.
                const stat = await sys.stat(pathStr);
                isDir = stat?.isDirectory || false;
            } catch (_) {
                // Ignore missing target
            }
        } catch (err: any) {
            console.warn(`[Webrun] stat failed for ${payload.targetScriptPath}:`, err.message);
        }
    }

    let userFetch: any = null;
    if (!isDir) {
        const mod = await import(payload.targetUrlHref);
        userFetch = mod.default?.fetch || mod.fetch;
        if (!userFetch) {
            console.warn(`[Webrun] Warning: Script at ${payload.targetScriptPath} does not export a fetch handler.`);
        }
    }

    if (userFetch) {
        console.log(`[Webrun] Mode: fetch handler from ${payload.targetScriptPath}`);
    } else if (isDir) {
        console.log(`[Webrun] Mode: static files from ${payload.targetScriptPath}/`);
    } else {
        console.log(`[Webrun] Mode: module shim for ${payload.targetScriptPath}`);
    }

    let targetFilename = "";
    if (!isDir) {
        // Find filename from targetScriptPath for the shim
        const parts = payload.targetScriptPath.split(/[\\/]/);
        targetFilename = parts.pop() || "";
    }

    const handler = async (req: Request) => {
        const url = new URL(req.url);
        let response: Response;

        if (userFetch) {
            response = await userFetch(req, contextPayload.env, contextPayload);
        } else if (!isDir && url.pathname === "/") {
            // If a specific script module was targeted but lacked a 'fetch' handler, 
            // we serve a dynamic JavaScript shim at the root to proxy exports.
            const shim = `export * from "./${targetFilename}";\nimport * as mod from "./${targetFilename}";\nexport default mod.default;`;
            response = new Response(shim, { headers: { "Content-Type": "text/javascript" } });
        } else {
            let finalPath = url.pathname;
            if (finalPath.endsWith("/")) finalPath += "index.html";
            if (finalPath.includes("..")) {
                response = new Response("Forbidden", { status: 403 });
                console.log(`${req.method} ${url.pathname} ${response.status}`);
                return response;
            }
            try {
                // Serve statically. If target was a file, serve from its parent directory.
                const targetPath = isDir ? payload.targetScriptPath : dirname(payload.targetScriptPath);
                const absolutePath = join(targetPath, finalPath);
                const ext = extname(absolutePath).toLowerCase();
                const cType = contentType(ext) || "application/octet-stream";
                const file = sys.readFileSync(absolutePath);
                response = new Response(file as BodyInit, { headers: { "Content-Type": cType } });
            } catch (err: any) {
                if (err.name === "NotFound") response = new Response("Not Found", { status: 404 });
                else response = new Response(err.message, { status: 500 });
            }
        }

        console.log(`${req.method} ${url.pathname} ${response!.status}`);
        return response!;
    };

    const servers: any[] = [];
    for (const iface of payload.serveInterfaces || []) {
        const server = sys.serve({ port: iface.port, hostname: iface.host, onListen: () => {} }, handler);
        servers.push(server);
        console.log(`Webrun serving at http://${server.addr.hostname}:${server.addr.port}/`);
    }

    const shutdown = async () => {
        for (const s of servers) {
            try { await s.shutdown(); } catch (_) {}
        }
        sys.exit(0);
    };

    try { sys.addSignalListener("SIGTERM", shutdown); } catch (_) {}
    try { sys.addSignalListener("SIGINT", shutdown); } catch (_) {}
}
