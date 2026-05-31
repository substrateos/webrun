import type { ViolationContext, WebrunPermissions, WebrunLimits } from "../types.ts";
import { SecurityViolation } from "../types.ts";
import type { LocalConfig } from "../config.ts";

function resolvePath(base: string, target: string): string {
    const p = new URL(target, "file://" + base + "/").pathname;
    return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

function isPathInside(child: string, parent: string): boolean {
    const childParts = child.split("/").filter(Boolean);
    const parentParts = parent.split("/").filter(Boolean);
    if (parentParts.length > childParts.length) return false;
    for (let i = 0; i < parentParts.length; i++) {
        if (childParts[i] !== parentParts[i]) return false;
    }
    return true;
}

/**
 * Ensures that the sandbox does not accidentally mount its own executable or
 * critical configuration files inside a directory that the untrusted child has write access to.
 * This prevents a child from overwriting the host environment to escape the sandbox.
 */
function validateSandboxSafetyBoundaries(
    protectedPaths: string[],
    allowedWritePaths: string[],
): ViolationContext[] {
    const violations: ViolationContext[] = [];
    for (const allowed of allowedWritePaths) {
        for (const rawProtectedFile of protectedPaths) {
            const protectedFile = rawProtectedFile;
            if (isPathInside(protectedFile, allowed)) {
                violations.push({
                    code: SecurityViolation.SandboxSafety,
                    message: "Executable in write directory",
                    child: protectedFile, parent: allowed,
                    extras: { Executable: protectedFile, Permitted: allowed },
                });
            }
        }
    }

    return violations;
}

/**
 * Enforces hierarchical capability narrowing up the config chain.
 * Checks that a child configuration does not escalate privileges (e.g. storage, network, env)
 * beyond what its parent directories have explicitly granted or delegated.
 * Also verifies network isolation requirements for isolated storage branches.
 */
export function validateCapabilityChain(
    configs: readonly Readonly<LocalConfig>[],
    resolveDir: (h: FileSystemDirectoryHandle) => string,
    canonicalize: (p: string) => string,
): ViolationContext[] {
    const targetConfig = configs[0];
    const initialConfigDir = configs[0].dir;
    const targetPerms = targetConfig.locationConfig.permissions;

    const network = targetPerms?.network || []
    const configDirPath = resolveDir(initialConfigDir);
    const rawStorageEntries = Object.entries(targetPerms?.storage || {});
    const storage: { path: string; access: string }[] = [];
    const traversalViolations: ViolationContext[] = [];

    for (const [k, v] of rawStorageEntries) {
        // Storage keys must not escape the configuration directory.
        const resolved = resolvePath(configDirPath, k);
        if (k !== "." && !isPathInside(resolved, configDirPath)) {
            traversalViolations.push({
                code: SecurityViolation.CapabilityEscalation,
                message: `SecurityError: Storage path "${k}" escapes configuration boundary`,
                child: configDirPath,
                parent: configDirPath,
            });
        } else {
            storage.push({ path: resolved, access: (v as any).access });
        }
    }
    if (traversalViolations.length > 0) return traversalViolations;
    const env = targetPerms?.env || []
    const importPerms = targetPerms?.import || []
    const gpu = !!targetPerms?.gpu
    const webrtc = !!targetPerms?.webrtc

    const violations: ViolationContext[] = [];
    const checkedConfigs = new Set<any>();

    for (let i = 0; i < configs.length; i++) {
        const rc = configs[i].locationConfig;
        const rootConfig = configs[i].config;
        const sourceDir = configs[i].dir;

        // 1. Isolate Check (Network Isolation)
        if (rootConfig.isolate && !checkedConfigs.has(rootConfig)) {
            checkedConfigs.add(rootConfig);

            for (const isolatePathRaw of rootConfig.isolate) {
                const isolatePath = canonicalize(resolvePath(resolveDir(sourceDir), isolatePathRaw));
                for (const reqStorage of storage) {
                    const reqPath = canonicalize(reqStorage.path);
                    if (isPathInside(reqPath, isolatePath)) {
                        if (network.length > 0) {
                            violations.push({
                                code: SecurityViolation.NetworkIsolation,
                                message: "Network isolation violated",
                                child: resolveDir(initialConfigDir),
                                parent: resolveDir(sourceDir),
                                extras: {
                                    IsolatedPath: isolatePathRaw,
                                    AttemptedStorage: reqStorage.path,
                                },
                            });
                        }
                    }
                }
            }
        }

        // 2. Capabilities Check (Default or Delegated)
        if (i > 0) {
            const defaultPerms = rc.permissions || {};
            let delegatedPerms: Record<string, any> | null = null;

            if (defaultPerms.delegate) {
                const canonicalRequestorDir = canonicalize(resolveDir(initialConfigDir));
                for (const [delegatePathRaw, perms] of Object.entries(defaultPerms.delegate)) {
                    const delegatePath = canonicalize(resolvePath(resolveDir(sourceDir), delegatePathRaw));
                    if (isPathInside(canonicalRequestorDir, delegatePath)) {
                        delegatedPerms = perms as Record<string, any>;
                        break;
                    }
                }
            }

            const childDir = resolveDir(initialConfigDir);
            const parentDir = resolveDir(sourceDir);

            for (const n of network) {
                if (!defaultPerms.network?.includes("*") && !defaultPerms.network?.includes(n) &&
                    !delegatedPerms?.network?.includes("*") && !delegatedPerms?.network?.includes(n)) {
                    violations.push({ code: SecurityViolation.CapabilityEscalation, message: `Escalating 'network' permissions: ${n}`, child: childDir, parent: parentDir });
                }
            }

            for (const e of env) {
                if (!defaultPerms.env?.includes("*") && !defaultPerms.env?.includes(e) &&
                    !delegatedPerms?.env?.includes("*") && !delegatedPerms?.env?.includes(e)) {
                    violations.push({ code: SecurityViolation.CapabilityEscalation, message: `Escalating 'env' permissions: ${e}`, child: childDir, parent: parentDir });
                }
            }

            for (const imp of importPerms) {
                if (!defaultPerms.import?.includes("*") && !defaultPerms.import?.includes(imp) &&
                    !delegatedPerms?.import?.includes("*") && !delegatedPerms?.import?.includes(imp)) {
                    violations.push({ code: SecurityViolation.CapabilityEscalation, message: `Escalating 'import' permissions: ${imp}`, child: childDir, parent: parentDir });
                }
            }

            if (gpu && !defaultPerms.gpu && !delegatedPerms?.gpu) {
                violations.push({ code: SecurityViolation.CapabilityEscalation, message: "Escalating 'gpu' permissions", child: childDir, parent: parentDir });
            }
            if (webrtc && !defaultPerms.webrtc && !delegatedPerms?.webrtc) {
                violations.push({ code: SecurityViolation.CapabilityEscalation, message: "Escalating 'webrtc' permissions", child: childDir, parent: parentDir });
            }

            const parentStorageAbs = Object.entries(defaultPerms.storage || {}).map(([k, v]: [string, any]) => ({ path: resolvePath(resolveDir(sourceDir), k), access: v.access }));
            const delegatedStorageAbs = Object.entries(delegatedPerms?.storage || {}).map(([k, v]: [string, any]) => ({ path: resolvePath(resolveDir(sourceDir), k), access: v.access }));
            const combinedAllowedStorage = [...parentStorageAbs, ...delegatedStorageAbs];

            for (const reqStore of storage) {
                let covered = false;
                for (const allowedStore of combinedAllowedStorage) {
                    if (isPathInside(reqStore.path, allowedStore.path)) {
                        if (reqStore.access === "write" && allowedStore.access !== "write") {
                            continue;
                        }
                        covered = true;
                        break;
                    }
                }
                if (!covered) {
                    violations.push({ code: SecurityViolation.CapabilityEscalation, message: `Escalating 'storage' permissions: ${reqStore.path}`, child: childDir, parent: parentDir });
                }
            }

            if (rc.limits) {
                if (rc.limits.timeoutMillis !== undefined && targetConfig.locationConfig.limits?.timeoutMillis !== undefined && targetConfig.locationConfig.limits.timeoutMillis > rc.limits.timeoutMillis) {
                    violations.push({ code: SecurityViolation.CapabilityEscalation, message: "Escalating 'timeoutMillis' limit", child: childDir, parent: parentDir });
                }
                if (rc.limits.memoryMB !== undefined && targetConfig.locationConfig.limits?.memoryMB !== undefined && targetConfig.locationConfig.limits.memoryMB > rc.limits.memoryMB) {
                    violations.push({ code: SecurityViolation.CapabilityEscalation, message: "Escalating 'memoryMB' limit", child: childDir, parent: parentDir });
                }
            }
        }
    }

    return violations;
}

/**
 * Validates that the requested binary execution exactly matches one of the
 * explicitly allowed binary prefixes. This prevents arbitrary code execution
 * by enforcing strict command signatures.
 */
function validateBinaryPrefix(argv: string[], allowedPrefixes: string[][]): ViolationContext[] {
    if (allowedPrefixes.length === 0) {
        return [{ code: SecurityViolation.BinaryDenied, message: `Binary execution denied: no binaries permitted. Command: ${argv[0]}`, child: argv[0], parent: "" }];
    }
    const matches = allowedPrefixes.some(prefix =>
        prefix.every((part, i) => argv[i] === part)
    );
    if (!matches) {
        return [{
            code: SecurityViolation.BinaryDenied,
            message: `Binary execution denied: [${argv.join(", ")}] does not match any allowed prefix. Allowed: ${allowedPrefixes.map(p => p.join(" ")).join("; ")}`,
            child: argv[0], parent: "",
        }];
    }
    return [];
}

interface ValidateInput {
    /** Config chain for capability escalation checks. Omit in sandbox (no chain). */
    chain?: readonly Readonly<LocalConfig>[];
    protectedPaths: string[];

    mode: "module" | "binary";
    argv: string[];

    allowedWritePaths: string[];
    allowedBinaryPrefixes: string[][];

    resolveDir: (h: FileSystemDirectoryHandle) => string;
    canonicalize: (p: string) => string;

    /** Security ceiling from parent run. If present, child config is validated against it. */
    ceiling?: { permissions: WebrunPermissions; limits: WebrunLimits; isolate: string[] };

    /** Target's permissions and limits — used for ceiling validation when chain is absent. */
    targetPermissions?: WebrunPermissions;
    targetLimits?: WebrunLimits;
}

/**
 * Validate that the target config's permissions do not exceed the ceiling.
 * Every permission the child requests must be present in the ceiling.
 */
function validateAgainstCeiling(
    targetPerms: WebrunPermissions,
    ceiling: { permissions: WebrunPermissions; limits: WebrunLimits },
    targetLimits: WebrunLimits | undefined,
): ViolationContext[] {
    const violations: ViolationContext[] = [];
    const cp = ceiling.permissions;

    // Network
    for (const n of targetPerms.network || []) {
        if (!cp.network?.includes("*") && !cp.network?.includes(n)) {
            violations.push({ code: SecurityViolation.CeilingViolation, message: `Ceiling violation: network '${n}' not permitted by parent`, child: "child", parent: "ceiling" });
        }
    }

    // Env
    for (const e of targetPerms.env || []) {
        if (!cp.env?.includes("*") && !cp.env?.includes(e)) {
            violations.push({ code: SecurityViolation.CeilingViolation, message: `Ceiling violation: env '${e}' not permitted by parent`, child: "child", parent: "ceiling" });
        }
    }

    // Import
    for (const imp of targetPerms.import || []) {
        if (!cp.import?.includes("*") && !cp.import?.includes(imp)) {
            violations.push({ code: SecurityViolation.CeilingViolation, message: `Ceiling violation: import '${imp}' not permitted by parent`, child: "child", parent: "ceiling" });
        }
    }

    // GPU
    if (targetPerms.gpu && !cp.gpu) {
        violations.push({ code: SecurityViolation.CeilingViolation, message: "Ceiling violation: gpu not permitted by parent", child: "child", parent: "ceiling" });
    }

    // WebRTC
    if (targetPerms.webrtc && !cp.webrtc) {
        violations.push({ code: SecurityViolation.CeilingViolation, message: "Ceiling violation: webrtc not permitted by parent", child: "child", parent: "ceiling" });
    }

    // Storage: each requested path+access must be covered by ceiling.
    // Both sides carry absolute paths (resolved at construction time).
    for (const [path, access] of Object.entries(targetPerms.storage || {})) {
        let covered = false;
        for (const [cPath, cAccess] of Object.entries(cp.storage || {})) {
            if (isPathInside(path, cPath)) {
                if ((access as any).access === "write" && (cAccess as any).access !== "write") continue;
                covered = true;
                break;
            }
        }
        if (!covered) {
            violations.push({ code: SecurityViolation.CeilingViolation, message: `Ceiling violation: storage '${path}' not permitted by parent`, child: "child", parent: "ceiling" });
        }
    }

    // Binaries
    for (const prefix of targetPerms.binaries || []) {
        const matches = (cp.binaries || []).some(cpPrefix =>
            cpPrefix.every((part, i) => prefix[i] === part)
        );
        if (!matches) {
            violations.push({ code: SecurityViolation.CeilingViolation, message: `Ceiling violation: binary '${prefix.join(" ")}' not permitted by parent`, child: "child", parent: "ceiling" });
        }
    }

    // Limits: child cannot exceed ceiling
    if (targetLimits) {
        if (ceiling.limits.timeoutMillis !== undefined && targetLimits.timeoutMillis !== undefined && targetLimits.timeoutMillis > ceiling.limits.timeoutMillis) {
            violations.push({ code: SecurityViolation.CeilingViolation, message: "Ceiling violation: timeoutMillis exceeds parent ceiling", child: "child", parent: "ceiling" });
        }
        if (ceiling.limits.memoryMB !== undefined && targetLimits.memoryMB !== undefined && targetLimits.memoryMB > ceiling.limits.memoryMB) {
            violations.push({ code: SecurityViolation.CeilingViolation, message: "Ceiling violation: memoryMB exceeds parent ceiling", child: "child", parent: "ceiling" });
        }
    }

    return violations;
}

/**
 * Run all policy checks: capability escalation, sandbox safety, binary prefix, ceiling.
 * Returns all violations found.
 */
export default function validate(input: ValidateInput): ViolationContext[] {
    const violations: ViolationContext[] = [];
    if (input.chain) {
        violations.push(...validateCapabilityChain(input.chain, input.resolveDir, input.canonicalize));
    }
    violations.push(...validateSandboxSafetyBoundaries(input.protectedPaths, input.allowedWritePaths));
    if (input.mode === "binary") {
        violations.push(...validateBinaryPrefix(input.argv, input.allowedBinaryPrefixes));
    }
    if (input.ceiling) {
        const targetPerms = input.targetPermissions || input.chain?.[0]?.locationConfig?.permissions || {};
        const targetLimits = input.targetLimits || input.chain?.[0]?.locationConfig?.limits;
        violations.push(...validateAgainstCeiling(targetPerms, input.ceiling, targetLimits));
    }
    return violations;
}

