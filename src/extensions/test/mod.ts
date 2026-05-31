// extensions/test/mod.ts — @webrun/test extension.
//
// Detects --test= in args, collects target files, and generates a
// single harness script via ctx.createObjectURL. The orchestrator
// sees a plain "run" with one URL target — no test-specific behavior.

import type { Context } from "../../core/types.ts";
import type { Extension } from "../mod.ts";

function generateHarnessScript(
    targetUrls: string[],
    testRunnerUrl: string,
    filterPattern: string,
): string {
    const urlsLiteral = JSON.stringify(targetUrls);
    const filterLiteral = JSON.stringify(filterPattern);
    const runnerLiteral = JSON.stringify(testRunnerUrl);

    return `
import { runTestSuite, createReporter } from ${runnerLiteral};

export default {
    async main(args, env, ctx) {
        const targetUrls = ${urlsLiteral};
        const filter = ${filterLiteral} || undefined;

        const print = (line) => {
            for (let attempt = 0; ; attempt++) {
                try { console.log(line); return; }
                catch (e) { if (attempt > 500 || e.name !== "WouldBlock") throw e; const d = performance.now() + 2; while (performance.now() < d); }
            }
        };

        const reporter = createReporter(print, { color: env.NO_COLOR === undefined });

        // Collect all tests grouped by source, preserving declaration order.
        const bySource = new Map();
        const seenNames = new Set();
        for (const url of targetUrls) {
            const mod = await import(url);
            if (!bySource.has(url)) bySource.set(url, []);
            for (const [name, fn] of Object.entries(mod)) {
                if (name.startsWith("test") && typeof fn === "function") {
                    const displayName = name.substring(4).trim() || name;
                    if (seenNames.has(displayName)) {
                        console.warn('[Webrun] Duplicate test name "' + displayName + '" — skipping duplicate registration.');
                        continue;
                    }
                    seenNames.add(displayName);
                    bySource.get(url).push({ name: displayName, fn });
                }
            }
        }

        if (seenNames.size === 0) {
            console.warn("[Webrun] No test exports found. Expected functions starting with 'test'.");
            return;
        }

        // Filter: first segment selects top-level test names. Skip entire
        // source files that have no matching top-level tests.
        const firstSegment = filter?.split(" > ")[0];

        let totalFailed = 0;
        for (const [source, tests] of bySource) {
            if (firstSegment) {
                const hasMatch = tests.some(({ name }) => name.includes(firstSegment));
                if (!hasMatch) continue;
            }
            const summary = await runTestSuite(tests, ctx, source, reporter, filter);
            totalFailed += summary.failed;
        }

        if (totalFailed > 0) ctx.exit(1);
    }
};
`;
}

/** Resolve a string path to a file:// URL relative to the working directory. */
function pathToFileUrl(path: string, cwd: string): string {
    let resolved: string;
    if (path.startsWith("/")) {
        resolved = path;
    } else {
        resolved = cwd + (cwd.endsWith("/") ? "" : "/") + path;
    }
    const encoded = encodeURI(resolved).replace(/#/g, "%23").replace(/\?/g, "%3F");
    return "file://" + encoded;
}

const test: Extension = async (
    ctx: Context,
    next: (ctx: Context) => Promise<void>,
    _config: Record<string, unknown>,
): Promise<void> => {
    const testFlag = ctx.flags.test;
    if (testFlag === undefined) return next(ctx);

    const filterPattern = typeof testFlag === "string" ? testFlag : "";

    // Remaining args: positional targets and preserved flags.
    const remainingArgs: string[] = [];
    const targetArgs: string[] = [];
    for (const arg of ctx.args) {
        if (arg.startsWith("-")) {
            remainingArgs.push(arg);
        } else {
            targetArgs.push(arg);
        }
    }

    // Resolve all targets to file:// URLs.
    const targetUrls: string[] = [];
    const allTargets = [ctx.location, ...targetArgs].filter(Boolean);

    if (!ctx.dir) {
        // Without storage, relative paths cannot be resolved.
        const relative = allTargets.find(a => !a.startsWith("http://") && !a.startsWith("https://") && !a.startsWith("file://") && !a.startsWith("data:") && !a.startsWith("/"));
        if (relative) {
            throw new Error(`Cannot resolve relative test path "${relative}": no storage permissions declared. Add storage permissions to webrun.json or use absolute paths.`);
        }
        for (const arg of allTargets) {
            targetUrls.push(arg.startsWith("/") ? `file://${arg}` : arg);
        }
    } else {
        const cwdUrl = ctx.createFileSystemHandleURL(ctx.dir);
        const cwd = cwdUrl.replace("file://", "").replace(/\/$/, "");
        for (const arg of allTargets) {
            if (arg.startsWith("http://") || arg.startsWith("https://") || arg.startsWith("file://") || arg.startsWith("data:")) {
                targetUrls.push(arg);
            } else {
                targetUrls.push(pathToFileUrl(arg, cwd));
            }
        }
    }

    if (targetUrls.length === 0) return next(ctx);

    // The test runner module is mapped as "@webrun/test" in the sandbox import map.
    const testRunnerUrl = "@webrun/test";

    // Generate harness script as a blob URL resolvable in the guest.
    const harnessCode = generateHarnessScript(
        targetUrls, testRunnerUrl, filterPattern,
    );
    const harnessUrl = URL.createObjectURL(
        new Blob([harnessCode], { type: "application/typescript" }),
    );

    try {
        await next({
            ...ctx,
            location: harnessUrl,
            args: [harnessUrl, ...remainingArgs],
            extensions: {
                ...ctx.extensions,
                "@webrun/test": { filterPattern, targetUrls },
            },
        });
    } finally {
        URL.revokeObjectURL(harnessUrl);
    }
};

export default test;
