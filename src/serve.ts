import type { SandboxContextPayload, ServeRuntime } from "./types.ts";
import { createStaticHandler, createModuleShimHandler } from "./static_server.ts";

export async function executeServePayload(sys: ServeRuntime, payload: SandboxContextPayload & { action: "serve" }, contextPayload: any) {
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
                const stat = await sys.stat(pathStr);
                isDir = stat?.isDirectory || false;
            } catch (_) {}
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

    // Build the handler by composing user fetch, static server, or module shim.
    const staticHandler = createStaticHandler(sys, payload.targetScriptPath, isDir);
    const shimHandler = !isDir
        ? createModuleShimHandler(payload.targetScriptPath.split(/[\\/]/).pop() || "")
        : null;

    const handler = async (req: Request) => {
        const url = new URL(req.url);
        let response: Response;

        if (userFetch) {
            response = await userFetch(req, contextPayload.env, contextPayload);
        } else if (!isDir && url.pathname === "/") {
            response = shimHandler!();
        } else {
            response = staticHandler(req);
        }

        console.log(`${req.method} ${url.pathname} ${response!.status}`);
        return response!;
    };

    const servers: any[] = [];
    for (const iface of payload.serveInterfaces) {
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
