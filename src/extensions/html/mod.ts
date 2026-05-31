// extensions/html/mod.ts — @webrun/html extension.
//
// Detects .html targets, reads them via fetch(ctx.meta.resolve()),
// extracts <script> tags, and runs each via ctx.run() with a properly
// computed import map. Each HTML file spawns its own child process.

import type { Context } from "../../core/types.ts";
import type { Extension } from "../mod.ts";
import { parseHtmlScripts, parseHtmlImportMap, HTML_FETCH_USER_AGENT } from "./parse.ts";

/** Read HTML content from a resolved URL. */
export async function readHtmlContent(
    url: string, allowedNetworkDomains: string[],
): Promise<string> {
    if (url.startsWith("http://") || url.startsWith("https://")) {
        const parsed = new URL(url);
        const isAllowed = allowedNetworkDomains.includes("*") || allowedNetworkDomains.includes(parsed.hostname);
        if (!isAllowed) throw new Error(`Network permission denied for "${url}". Add "${parsed.hostname}" to permissions.network.`);
        const resp = await fetch(url, { headers: { "User-Agent": HTML_FETCH_USER_AGENT }, redirect: "follow" });
        if (!resp.ok) throw new Error(`Failed to fetch "${url}": ${resp.status}`);
        return resp.text();
    }
    // file:// URLs — fetch reads directly with Deno's --allow-read.
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to read "${url}": ${resp.status}`);
    return resp.text();
}

/** Resolve a specifier against the HTML file's URL. */
function resolveRelative(htmlUrl: string, specifier: string): string {
    if (specifier.startsWith("http://") || specifier.startsWith("https://") || specifier.startsWith("file://")) {
        return specifier;
    }
    return new URL(specifier, htmlUrl).href;
}

/** Directory URL of a file URL (everything up to the last /). */
function dirUrl(fileUrl: string): string {
    const i = fileUrl.lastIndexOf('/');
    return i >= 0 ? fileUrl.substring(0, i + 1) : fileUrl;
}

/** Rewrite an inline import map's relative entries to absolute URLs. */
function rewriteInlineImportMap(
    inlineMap: any, htmlUrl: string,
): Record<string, string> {
    const entries: Record<string, string> = {};
    if (!inlineMap?.imports) return entries;
    for (const [key, value] of Object.entries(inlineMap.imports)) {
        if (typeof value !== 'string') continue;
        entries[key] = resolveRelative(htmlUrl, value);
    }
    return entries;
}

/**
 * Rewrite relative import/export specifiers in inline script content to
 * absolute file:// URLs resolved against the HTML source directory.
 *
 * Matches: import ... from "./foo", export ... from "../bar",
 *          import("./baz"), import "./qux"
 */
function rewriteRelativeImports(content: string, htmlDirUrl: string): string {
    // Match import/export from with relative specifiers.
    return content.replace(
        /((?:import|export)\s+(?:(?:\{[^}]*\}|[^;'"]*)\s+from\s+|(?:\()))(["'])(\.[^"']*)\2/g,
        (_match, prefix, quote, specifier) => {
            const absolute = new URL(specifier, htmlDirUrl).href;
            return `${prefix}${quote}${absolute}${quote}`;
        },
    );
}

const html: Extension = async (ctx, next, config) => {
    const isHtml = (s: string) => typeof s === 'string' && !s.startsWith("-") && s.toLowerCase().endsWith(".html");
    const hasHtml = isHtml(ctx.location) || ctx.args.some(isHtml);
    if (!hasHtml) return next(ctx);

    const allowedNetworkDomains = (config.network as string[] | undefined) || [];
    const isTestMode = ctx.flags.test !== undefined;

    // Collect HTML targets and passthrough flags.
    const allEntries = [ctx.location, ...ctx.args];
    const flags: string[] = [];
    const htmlEntries: string[] = [];
    for (const entry of allEntries) {
        if (isHtml(entry)) {
            htmlEntries.push(entry);
        } else if (typeof entry === 'string' && entry.startsWith("-")) {
            flags.push(entry);
        }
    }

    if (htmlEntries.length === 0) return next(ctx);

    const tmpDir = await ctx.makeTempDir({ prefix: "webrun_html_" });
    let anyFailed = false;

    for (const entry of htmlEntries) {
        // Resolve the HTML entry to an absolute URL.
        // CLI args are CWD-relative, so resolve against ctx.meta.cwd.
        const htmlUrl = resolveRelative(ctx.meta.cwd, entry);
        const htmlDirUrl = dirUrl(htmlUrl);

        const htmlContent = await readHtmlContent(htmlUrl, allowedNetworkDomains);
        const allScripts = parseHtmlScripts(htmlContent);
        const scripts = allScripts.filter(s => !s.skip);
        if (scripts.length === 0) continue;

        // Parse inline import map and resolve relative specifiers.
        const inlineImportMap = parseHtmlImportMap(htmlContent);
        const inlineImports = inlineImportMap ? rewriteInlineImportMap(inlineImportMap, htmlUrl) : {};

        // Merge parent import map with HTML-inline entries.
        const imports: Record<string, string> = {
            ...ctx.importMap?.imports,
            ...inlineImports,
        };

        let inlineIdx = 0;
        for (const script of scripts) {
            let targetUrl: string;
            let fileHandle: FileSystemFileHandle | undefined;
            let scopes: Record<string, Record<string, string>> = { ...ctx.importMap?.scopes };

            if (script.src) {
                // External src: resolve against the HTML file's URL.
                targetUrl = resolveRelative(htmlUrl, script.src);
            } else {
                // Inline script: rewrite relative imports to absolute URLs
                // (since the script runs from a temp dir, not the HTML source dir),
                // then write to a temp file.
                const name = `script_${inlineIdx++}.ts`;
                const uuid = crypto.randomUUID();
                const scriptDir = await tmpDir.getDirectoryHandle(uuid, { create: true });
                fileHandle = await scriptDir.getFileHandle(name, { create: true });

                // Rewrite relative imports (./foo, ../bar) to absolute file:// URLs
                // resolved against the HTML file's directory.
                const rewritten = rewriteRelativeImports(script.content || "", htmlDirUrl);

                const writable = await fileHandle.createWritable();
                await writable.write(rewritten);
                await writable.close();

                targetUrl = ctx.createFileSystemHandleURL(fileHandle);
            }

            // Build args: use ctx.run.arg for handle-backed targets (grants temp read).
            const target = fileHandle ? ctx.run.arg`${fileHandle}` : targetUrl;
            const childArgs = isTestMode
                ? ["--test", target, ...flags]
                : [target, ...flags];

            // Grant child read access to the temp dir (where extracted scripts live).
            const storage: Array<{ handle: FileSystemDirectoryHandle | FileSystemFileHandle; access: "read" | "write" }> = [];
            if (fileHandle) {
                storage.push({ handle: tmpDir, access: "read" as const });
            }

            const handle = await ctx.run(childArgs, {
                importMap: { imports, scopes },
                storage,
            });

            const [exitCode] = await Promise.all([
                handle.exitCode,
                pipeStream(handle.stdout ?? undefined, ctx.stdout),
                pipeStream(handle.stderr ?? undefined, ctx.stderr),
            ]);
            if (exitCode !== 0) anyFailed = true;
        }
    }

    if (anyFailed) ctx.exit(1);
    // Short-circuit: HTML extension handles all execution.
};

/** Pipe a child stream to a parent stream. */
async function pipeStream(
    source: ReadableStream<Uint8Array> | undefined,
    dest: WritableStream<Uint8Array> | undefined | null,
): Promise<void> {
    if (!source || !dest) {
        if (source) await source.cancel();
        return;
    }
    await source.pipeTo(dest, { preventClose: true });
}

export default html;
