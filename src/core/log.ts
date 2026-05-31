export function printUsageError(msg: string) {
    console.error(`[Usage] ${msg}`);
}
export function printWarning(msg: string) {
    console.error(`[Warning] ${msg}`);
}

/**
 * Formats and prints a runtime error in browser-style output.
 *
 * Browser consoles print errors as:
 *   Uncaught ReferenceError: foo is not defined
 *       at https://example.com/app.js:12:3
 *
 * We mirror this style, adding webrun-specific hints when relevant
 * (e.g. permission errors, import failures).
 */
export function printExecutionError(msg: string, detail?: string) {
    const rewritten = rewriteForHumans(msg);
    console.error(`\nUncaught Error: ${rewritten}`);
    if (detail) console.error(`  ${detail}`);
}

/**
 * Prints a full error with stack trace in browser-style output.
 * Filters Deno-internal frames (ext:, node:) from the stack.
 */
export function printExecutionErrorWithStack(err: unknown) {
    const { message, stack, name } = normalizeError(err);
    const rewritten = rewriteForHumans(message);
    const errorType = name && name !== "Error" ? name : "";
    const prefix = errorType ? `${errorType}: ` : "";

    console.error(`\nUncaught ${prefix}${rewritten}`);

    if (stack) {
        const cleaned = cleanStack(stack, message);
        if (cleaned) console.error(cleaned);
    }
}

export function printFatalError(msg: string, detail?: string) {
    console.error(`[Fatal] ${msg}`);
    if (detail) console.error(`  ${detail}`);
}


// ── Internal helpers ────────────────────────────────────────────────────

/** Extracts a structured { message, stack, name } from any thrown value. */
function normalizeError(err: unknown): { message: string; stack?: string; name?: string } {
    if (err instanceof Error) {
        return { message: err.message, stack: err.stack, name: err.name };
    }
    if (err && typeof err === "object") {
        const e = err as any;
        return {
            message: e.message || String(err),
            stack: e.stack,
            name: e.name,
        };
    }
    return { message: String(err) };
}

/**
 * Cleans a V8/Deno stack trace:
 *   - Removes the first line if it duplicates the error message.
 *   - Filters Deno-internal frames (ext:, node:, deno:).
 *   - Strips file:// prefixes for local paths.
 */
function cleanStack(stack: string, message: string): string {
    const lines = stack.split("\n");

    // V8 stacks start with "ErrorType: message" — skip if present.
    const startIdx = lines[0]?.includes(message) ? 1 : 0;

    const cleaned = lines
        .slice(startIdx)
        .filter(line => {
            const trimmed = line.trim();
            // Keep only "at ..." frames, skip internal Deno/node frames.
            if (!trimmed.startsWith("at ")) return false;
            if (trimmed.includes("ext:")) return false;
            if (trimmed.includes("node:")) return false;
            if (trimmed.includes("deno:")) return false;
            return true;
        })
        .map(line => line.replace(/file:\/\//g, ""))
        .join("\n");

    return cleaned;
}

/** Rewrites common error messages into webrun-specific language. */
export function rewriteForHumans(msg: string): string {
    if (!msg) return msg;

    // Deno permission errors → webrun.json hint.
    if (msg.includes("run again with the --allow-")) {
        return msg.replace(/, run again with the --allow-[a-z-]+ flag/g, "")
            + "\n  Hint: Update the 'permissions' object in your webrun.json to allow this operation.";
    }

    // NotCapable errors (newer Deno) — same hint.
    if (msg.startsWith("Requires ") && msg.includes(" access to ")) {
        return msg
            + "\n  Hint: Update the 'permissions' object in your webrun.json to allow this operation.";
    }

    // Import failures — extract the URL and explain.
    const importMatch = msg.match(/^Import '(.+)' failed\.?\s*(.*)/);
    if (importMatch) {
        const url = importMatch[1];
        const rest = importMatch[2] || "";
        return `Failed to load module: ${url}`
            + (rest ? `\n  ${rest}` : "")
            + `\n  Hint: Ensure the URL is accessible and listed in permissions.import in webrun.json.`;
    }

    // "X is not defined" — suggest the missing global.
    const notDefinedMatch = msg.match(/^(\w+) is not defined$/);
    if (notDefinedMatch) {
        const name = notDefinedMatch[1];
        if (name === "Deno") {
            return `${msg}\n  Hint: This module uses Deno-specific APIs. webrun provides a browser-like environment where Deno globals are not available.`;
        }
        if (name === "process" || name === "Buffer" || name === "require" || name === "global") {
            return `${msg}\n  Hint: This module uses Node.js-specific APIs. webrun provides a browser-like environment where Node.js globals are not available.`;
        }
    }

    return msg;
}
