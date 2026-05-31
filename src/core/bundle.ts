/**
 * Extract the text between two marker strings.
 * Returns undefined if either marker is not found.
 */
function extractSection(text: string, begin?: string, end?: string): string | undefined {
    if (!begin || !end) return text;
    const startIdx = text.indexOf(begin);
    const endIdx = text.indexOf(end, startIdx + begin.length);
    if (startIdx === -1 || endIdx === -1) return undefined;
    return text.substring(startIdx + begin.length, endIdx).trim();
}

/**
 * Returns a thunk that reads text and optionally extracts
 * the section between two markers. Sync or async depending on `read`.
 */
export function createSectionReader<T extends string | Promise<string>>(
    read: () => T,
    begin?: string,
    end?: string,
): () => T extends Promise<string> ? Promise<string | undefined> : (string | undefined) {
    return (() => {
        const result = read();
        if (result instanceof Promise) {
            return result.then(text => extractSection(text, begin, end));
        }
        return extractSection(result, begin, end);
    }) as any;
}

export interface BundleInfo {
    version: string;
    /** Entry target for `deno run` — the bundled webrun.js. */
    main: string;
    /** Path to the webrun wrapper script (WEBRUN_BIN). */
    bin?: string;
    /** Absolute path to the runtime binary (e.g. Deno). */
    execPath: string;
    /** Directory containing the runtime binary. */
    binDir: string;
    /** Path to the bundled worker blob (WEBRUN_WORKER). */
    workerPath?: string;
    /** Path to the bundled test adapter (WEBRUN_TEST_ADAPTER). */
    testAdapterPath?: string;
    /** Path to the bundled WebRTC polyfill (WEBRUN_WEBRTC_BUNDLE). */
    webrtcBundlePath?: string;
    /** Directories containing webrun's own bundle files that the sandbox must read. */
    sourceDirs: string[];

    /** Paths that the sandbox must not write to. */
    protectedPaths: string[];
}

/**
 * Parses WEBRUN_* env vars set by the bash wrapper script.
 * Returns structured bundle metadata with a lazy README reader.
 */
export function parseBundleEnv(
    env: Record<string, string>,
    readTextFile: (path: string) => string | Promise<string>,
    execPath: string,
): { bundle: BundleInfo; readReadme?: () => Promise<string | undefined> } {
    const path = env["WEBRUN_README_PATH"];
    const rawMain = env["WEBRUN_MAIN"];
    const bin = env["WEBRUN_BIN"];
    const binDir = execPath.substring(0, execPath.lastIndexOf("/")) || "/";
    const mainDir = rawMain ? rawMain.substring(0, rawMain.lastIndexOf("/")) || "/" : "/";
    const workerPath = env["WEBRUN_WORKER"];
    const testAdapterPath = env["WEBRUN_TEST_ADAPTER"];
    const webrtcBundlePath = env["WEBRUN_WEBRTC_BUNDLE"];
    const workerDir = workerPath ? workerPath.substring(0, workerPath.lastIndexOf("/")) || "/" : undefined;
    const protectedPaths = [rawMain, bin, path].filter(Boolean) as string[];

    // Directories containing webrun's own bundle files.
    const sourceDirs = [mainDir, ...(workerDir && workerDir !== mainDir ? [workerDir] : [])];

    return {
        bundle: {
            version: env["WEBRUN_VERSION"] || "dev",
            main: rawMain,
            bin,
            execPath,
            binDir,
            workerPath,
            testAdapterPath,
            webrtcBundlePath,
            sourceDirs,
            protectedPaths,
        },
        readReadme: path
            ? async () => createSectionReader(
                () => readTextFile(path),
                env["WEBRUN_README_BEGIN"],
                env["WEBRUN_README_END"],
            )()
            : undefined,
    };
}

