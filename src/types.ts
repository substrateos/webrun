// =========================================================
// 1. TYPES & DOMAIN MODELS
// =========================================================
export interface WebrunConfig {
    limits?: { timeoutMillis?: number, memoryMB?: number };
    permissions?: {
        storage?: Record<string, { access: "read" | "write" }>;
        network?: string[];
        env?: string[];
        bindings?: string[];
        gpu?: boolean;
    };
    bindings?: Record<string, any>;
    importMap?: string;
}
export interface CommandInvocation {
    action: "run" | "test" | "eval" | "check-only";
    isSelfTest?: boolean;
    targetScriptPath: string | string[];
    evalCode?: string;
    sandboxArgs: string[];
    injectedArgsObj: Record<string, any>;
    networkFlags: string[];
    isNoCheck?: boolean;
}

export interface SandboxContextPayload {
    action: "run" | "test" | "eval" | "check-only";
    isSelfTest?: boolean;
    webrunBin?: string;
    isRepackedTest?: boolean;
    isSelfCheck?: boolean;
    storageRoot: string;
    fallbackToTemp: boolean;
    injectedArgsObj: Record<string, any>;
    finalEnvVars: Record<string, string>;
    targetUrlHref: string | string[];
    targetScriptPath: string | string[];
    evalCode?: string;
    sandboxArgs: string[];
    opfsRoot: string;
    memoryMB?: number;
    bindingsMap: Record<string, { type: "process" | "module"; uuid: string; path?: string; port?: number }>;
    allowedBindings: Record<string, { access: "read" | "write" }>;
    allowGpu?: boolean;
}

