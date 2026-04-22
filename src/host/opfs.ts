import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";
import { printFatalError } from "../log.ts";
import { tryRealpathSync } from "../sys.ts";
import type { HostRuntime } from "../types.ts";

/**
 * Computes a deterministic OPFS bucket ID from a canonical directory path.
 * Pure function — base64-encodes the path and strips URL-unsafe characters.
 */
export function computeOpfsPathId(canonicalConfigDir: string): string {
    return btoa(canonicalConfigDir).replace(/[\/+=]/g, "");
}

export function appendTextFileSync(sys: HostRuntime, path: string, data: string) {
    const f = sys.openSync(path, { append: true, create: true, write: true });
    try { f.writeSync(new TextEncoder().encode(data)); } finally { f.close(); }
}

/**
 * Resolves the OPFS storage directory based on the configured origin strategy.
 *
 * - "git": Derives bucket ID from the repo's root commit hash (shared across clones).
 * - "path": Derives bucket ID from the canonical configDir path (per-directory).
 * - undefined: Ephemeral OPFS — creates a temp dir that is destroyed on exit.
 *
 * Returns the resolved opfsTmp path and whether the storage is ephemeral.
 */
export function resolveOpfsStorage(
    sys: HostRuntime,
    opfsOrigin: "git" | "path" | undefined,
    configDir: string,
    configPaths: string[],
    argsCopy: string[],
): { opfsTmp: string; isEphemeral: boolean } {
    if (opfsOrigin !== "git" && opfsOrigin !== "path") {
        return {
            opfsTmp: sys.realPathSync(sys.makeTempDirSync({ prefix: 'webrun_opfs_' })),
            isEphemeral: true,
        };
    }

    let opfsId = "";
    if (opfsOrigin === "git") {
        try {
            const isMac = sys.build.os === "darwin";
            let cmd;
            if (isMac) {
                const canonicalDir = tryRealpathSync(sys, configDir) || configDir;
                const gitJailProfile = `(version 1)
(deny default)
(import "bsd.sb")
(allow file-read-metadata)
(allow file-read*
    (subpath "/usr")
    (subpath "/System")
    (subpath "/Library")
    (subpath "/opt/homebrew")
    (subpath "/private/etc")
    (subpath "/private/var/folders")
    (subpath "/var/folders")
    (subpath "${configDir}")
    (subpath "${canonicalDir}")
)
(allow file-write*
    (regex #"^/private/var/folders/.*/xcrun_db")
    (regex #"^/var/folders/.*/xcrun_db")
)
(allow process-exec
    (literal "/usr/bin/git")
    (literal "/usr/bin/sandbox-exec")
    (literal "/usr/bin/xcrun")
    (subpath "/Library/Developer/CommandLineTools")
)
(allow process-fork)
(allow sysctl-read)
(allow mach-lookup)
(deny network*)
`;
                cmd = new sys.Command("/usr/bin/sandbox-exec", {
                    args: ["-p", gitJailProfile, "/usr/bin/git", "rev-list", "--max-parents=0", "HEAD"],
                    cwd: configDir,
                    stdout: "piped",
                    stderr: "piped",
                    clearEnv: true,
                    env: {
                        "HOME": sys.env.get("HOME") || "/tmp",
                        "PATH": "/usr/bin:/bin",
                        "GIT_CONFIG_GLOBAL": "/dev/null",
                        "GIT_CONFIG_NOSYSTEM": "1",
                    }
                });
            } else {
                cmd = new sys.Command("/usr/bin/git", {
                    args: ["rev-list", "--max-parents=0", "HEAD"],
                    cwd: configDir,
                    stdout: "piped",
                    stderr: "piped",
                    clearEnv: true,
                    env: {
                        "HOME": sys.env.get("HOME") || "/tmp",
                        "PATH": "/usr/bin:/bin",
                        "GIT_CONFIG_GLOBAL": "/dev/null",
                        "GIT_CONFIG_NOSYSTEM": "1",
                    }
                });
            }
            const out = cmd.outputSync();
            const gitStderr = new TextDecoder().decode(out.stderr).trim();
            if (out.code !== 0) throw new Error(`git exited ${out.code}: ${gitStderr}`);
            opfsId = new TextDecoder().decode(out.stdout).trim().split("\n")[0];
            if (!opfsId) throw new Error("No git commit found (empty rev-list output)");
        } catch (err: any) {
            printFatalError("Configuration Error",
                `The 'git' OPFS origin strategy requires a valid git repository.\n  detail: ${err?.message ?? err}`);
            sys.exit(1);
        }
    } else {
        const canonicalConfigDir = tryRealpathSync(sys, configDir) || configDir;
        opfsId = computeOpfsPathId(canonicalConfigDir);
    }

    const namespaceDir = resolve(sys.env.get("HOME") || "/tmp", ".webrun", "opfs", opfsOrigin, opfsId);
    let opfsTmp = tryRealpathSync(sys, resolve(namespaceDir, "fs")) || resolve(namespaceDir, "fs");
    try { sys.mkdirSync(opfsTmp, { recursive: true }); } catch (_) { }
    opfsTmp = tryRealpathSync(sys, opfsTmp) || opfsTmp;

    try {
        const auditEntry = JSON.stringify({
            timestamp: new Date().toISOString(),
            configPath: configPaths.length > 0 ? (tryRealpathSync(sys, configPaths[0]) || configPaths[0]) : configDir,
            args: argsCopy
        }) + "\n";
        const auditPath = resolve(namespaceDir, "audit.ndjson");
        appendTextFileSync(sys, auditPath, auditEntry);
    } catch (_) { }

    return { opfsTmp, isEphemeral: false };
}
