// html_test.ts — HTML test target processing for webrun --test.
//
// Extracts <script type="module"> tags from HTML files, writes them to
// ephemeral .ts files, and configures import maps so relative imports
// resolve against the original HTML file's directory.
//
// Pure parsing functions (parseHtmlScripts, parseHtmlImportMap) are
// exported for unit testing. The orchestrator (processHtmlTestTargets)
// is async and handles file I/O and remote fetching.

import { resolve, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
/** Web-standard replacement for node:url's pathToFileURL.
 *  Avoids a node: import that the sandbox sinkhole blocks in bundled tests. */
function pathToFileURL(path: string): URL {
    return new URL("file://" + encodeURI(path).replace(/#/g, "%23").replace(/\?/g, "%3F"));
}
import { rewriteImportMapPathsToAbsolute, mergeImportMaps } from "../config.ts";
import type { CommandInvocation, HostRuntime } from "../types.ts";

// =========================================================
// USER-AGENT FOR HTML FETCHING
// =========================================================

export const HTML_FETCH_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 webrun/1.0";

// =========================================================
// PURE PARSING FUNCTIONS
// =========================================================

/** Parsed module script extracted from an HTML document. */
export interface ParsedScript {
    /** The inline script content (trimmed), if no src attribute is present. */
    content?: string;
    /** The resolved src attribute (if present). */
    src?: string;
    /** Whether the `webrun-skip` attribute is present. */
    skip: boolean;
}

/**
 * Extracts executable script tags from HTML.
 * Only extracts scripts with omitted type, "module", "text/javascript",
 * "application/javascript", or "module+webrun".
 * Returns scripts in document order.
 */
export function parseHtmlScripts(html: string): ParsedScript[] {
    const results: ParsedScript[] = [];
    const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let match;

    while ((match = scriptRegex.exec(html)) !== null) {
        const attrs = match[1];
        const content = match[2];

        const typeMatch = attrs.match(/type\s*=\s*["']([^"']+)["']/i);
        const type = typeMatch ? typeMatch[1].toLowerCase().trim() : "";

        // Browsers only execute scripts if type is omitted or matches a known JS MIME type.
        // We add "module+webrun" for scripts meant exclusively for webrun execution.
        const isExecutableType = 
            type === "" ||
            type === "module" ||
            type === "module+webrun" ||
            type === "text/javascript" ||
            type === "application/javascript";
            
        if (!isExecutableType) continue;

        // Extract src attribute.
        const srcMatch = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
        const src = srcMatch ? srcMatch[1] : undefined;

        // Check for webrun-skip attribute.
        const skip = /\bwebrun-skip\b/i.test(attrs);

        if (src) {
            results.push({ src, skip });
        } else {
            results.push({ content: content.trim(), skip });
        }
    }

    return results;
}

/**
 * Extracts the first `<script type="importmap">` from HTML and parses it as JSON.
 * Returns null if no importmap is found.
 */
export function parseHtmlImportMap(html: string): any | null {
    const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let match;

    while ((match = scriptRegex.exec(html)) !== null) {
        const attrs = match[1];
        const content = match[2];

        const typeMatch = attrs.match(/type\s*=\s*["']([^"']+)["']/i);
        const type = typeMatch ? typeMatch[1].toLowerCase() : "";
        if (type !== "importmap") continue;

        try {
            return JSON.parse(content.trim());
        } catch {
            return null;
        }
    }

    return null;
}

// =========================================================
// ORCHESTRATOR
// =========================================================

/**
 * Computes the base URL for an HTML target.
 * For local paths: file:///absolute/dir/
 * For remote URLs: parent directory of the URL
 */
function computeBaseUrl(target: string): string {
    if (target.startsWith("http://") || target.startsWith("https://")) {
        const url = new URL(target);
        const lastSlash = url.pathname.lastIndexOf("/");
        url.pathname = url.pathname.substring(0, lastSlash + 1);
        return url.href;
    }
    if (target.startsWith("file://")) {
        const url = new URL(target);
        const lastSlash = url.pathname.lastIndexOf("/");
        url.pathname = url.pathname.substring(0, lastSlash + 1);
        return url.href;
    }
    // Local file path.
    const dir = dirname(resolve(target));
    return pathToFileURL(dir).href + "/";
}

/**
 * Reads HTML content from a target (local file, file:// URL, or remote URL).
 * For remote URLs, fetches with a browser-like user agent that includes "webrun".
 * Validates that remote URLs are permitted by the network permissions.
 */
async function readHtmlContent(
    sys: HostRuntime,
    target: string,
    allowedNetworkDomains: string[],
): Promise<string> {
    if (target.startsWith("http://") || target.startsWith("https://")) {
        // Validate network permission.
        const url = new URL(target);
        const hostname = url.hostname;
        const hasWildcard = allowedNetworkDomains.includes("*");
        const isAllowed = hasWildcard || allowedNetworkDomains.includes(hostname);
        if (!isAllowed) {
            throw new Error(
                `Network permission denied: cannot fetch remote HTML test target "${target}". ` +
                `Add "${hostname}" to permissions.network in webrun.json.`
            );
        }
        const resp = await fetch(target, {
            headers: { "User-Agent": HTML_FETCH_USER_AGENT },
            redirect: "follow",
        });
        if (!resp.ok) {
            throw new Error(`Failed to fetch HTML test target "${target}": ${resp.status} ${resp.statusText}`);
        }
        return resp.text();
    }

    if (target.startsWith("file://")) {
        const path = new URL(target).pathname;
        return sys.readTextFileSync(path);
    }

    // Local file path.
    return sys.readTextFileSync(target);
}

/**
 * Processes HTML test targets in-place on the invocation.
 *
 * For each .html target:
 * 1. Reads the HTML content (local or remote)
 * 2. Extracts <script type="module"> tags (filtering out enabled="browser")
 * 3. Writes extracted scripts to runnerTmp/<uuid>/script_N.ts
 * 4. Extracts <script type="importmap"> and merges into importMapPaths
 * 5. Configures scoped import map so relative imports resolve against the HTML file's dir
 * 6. Replaces the .html target with the generated .ts targets
 */
export async function processHtmlTestTargets(
    sys: HostRuntime,
    invocation: CommandInvocation,
    runnerTmp: string,
    importMapPaths: string[],
    allowedNetworkDomains: string[] = [],
): Promise<void> {
    const targets = [invocation.targetScriptPath, ...(invocation.additionalTargets || [])];
    const newPrimaryTarget: string | null = null;
    const newAdditionalTargets: string[] = [];
    let anyHtml = false;

    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        if (!target.toLowerCase().endsWith(".html")) {
            if (i === 0) {
                // Keep as primary target — will be overwritten if HTML found.
            }
            newAdditionalTargets.push(target);
            continue;
        }
        anyHtml = true;

        const html = await readHtmlContent(sys, target, allowedNetworkDomains);
        const baseUrl = computeBaseUrl(target);

        // Compute the canonical URL for this specific target (used for mirroring).
        const targetUrl = target.startsWith("http://") || target.startsWith("https://") || target.startsWith("file://")
            ? target
            : pathToFileURL(resolve(target)).href;

        // Extract and filter scripts.
        const allScripts = parseHtmlScripts(html);
        const scripts = allScripts.filter(s => !s.skip);

        if (scripts.length === 0) continue;

        // Extract importmap and merge.
        const importMap = parseHtmlImportMap(html);

        // Create a unique directory mirroring the URL structure.
        const targetUrlObj = new URL(targetUrl);
        const scheme = targetUrlObj.protocol.slice(0, -1);
        const host = targetUrlObj.host;
        const relativeMirrorDir = dirname(targetUrlObj.pathname).replace(/^\/+/, "");
        
        const uuid = crypto.randomUUID();
        const extractDir = resolve(runnerTmp, uuid, scheme, host, relativeMirrorDir);
        sys.mkdirSync(extractDir, { recursive: true });

        // Map the scheme root back to the original origin.
        // This natively handles relative imports (../) escaping the HTML's directory.
        const schemeRoot = resolve(runnerTmp, uuid, scheme, host);
        const schemeRootUrl = pathToFileURL(schemeRoot).href + "/";
        const originalRootUrl = `${targetUrlObj.protocol}//${targetUrlObj.host}/`;
        
        const scopeMap: any = { imports: {}, scopes: {} };
        scopeMap.imports[schemeRootUrl] = originalRootUrl;

        // If the HTML had an inline importmap, rewrite its relative paths
        // against the HTML file's base directory and merge.
        if (importMap) {
            // For local files, resolve against the filesystem directory.
            // For remote files, the baseUrl is already absolute.
            if (!target.startsWith("http://") && !target.startsWith("https://")) {
                const localDir = target.startsWith("file://")
                    ? dirname(new URL(target).pathname)
                    : dirname(resolve(target));
                rewriteImportMapPathsToAbsolute(importMap, localDir);
            }
            mergeImportMaps(scopeMap, importMap);
        }

        // Write extracted scripts and add self-identity mappings.
        for (let j = 0; j < scripts.length; j++) {
            const script = scripts[j];
            let scriptPath: string;

            if (script.src) {
                // Resolve src relative to the HTML file's base directory.
                if (script.src.startsWith("http://") || script.src.startsWith("https://")) {
                    scriptPath = script.src;
                } else if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("file://")) {
                    scriptPath = new URL(script.src, target).href;
                } else {
                    const localDir = dirname(resolve(target));
                    scriptPath = resolve(localDir, script.src);
                }
            } else {
                scriptPath = resolve(extractDir, `script_${j}.ts`);
                sys.writeTextFileSync(scriptPath, script.content || "");
                const scriptUrl = pathToFileURL(scriptPath).href;

                // Prevent the global mapping from redirecting the inline script itself
                // if it were ever self-referenced.
                scopeMap.imports[scriptUrl] = scriptUrl;
            }

            // Register the mapping from script path to its original location.
            invocation.scriptLocations ??= {};
            invocation.scriptLocations[scriptPath] = targetUrl;
            // Store srcdoc once per location URL (deduplicated across scripts).
            invocation.srcdocs ??= {};
            invocation.srcdocs[targetUrl] ??= html;

            // Track as a test target.
            if (i === 0 && j === 0 && newPrimaryTarget === null) {
                invocation.targetScriptPath = scriptPath;
            } else {
                newAdditionalTargets.push(scriptPath);
            }
        }

        // Write the scope map and register it for merging.
        const mapPath = resolve(runnerTmp, `html_import_map_${uuid}.json`);
        sys.writeTextFileSync(mapPath, JSON.stringify(scopeMap));
        importMapPaths.push(mapPath);
    }

    if (anyHtml) {
        // Rebuild additionalTargets, excluding the original HTML files
        // (they've been replaced by extracted .ts files).
        const finalAdditional = newAdditionalTargets.filter(t => !t.toLowerCase().endsWith(".html"));
        invocation.additionalTargets = finalAdditional.length > 0 ? finalAdditional : undefined;
    }
}
