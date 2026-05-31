// parse.ts — Pure HTML parsing utilities.
//
// Extracts <script type="module"> tags and import maps from HTML documents.

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
