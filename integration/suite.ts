// suite.ts — Integration test case schema and discovery.
// All filesystem operations use FileSystemDirectoryHandle (FSDH).

export interface ContainsRule { contains?: string; absent?: string }

type Runner = "cli" | "deno-shim"

export interface HttpProbe {
    method?: string;
    path: string;
    request_headers?: Record<string, string>;
    request_body?: string;
    status?: number;
    headers?: Record<string, string>;
    body?: ContainsRule[];
}

export interface WsProbe {
    path: string;
    send: string;
    expect_reply: string;
    timeout_ms?: number;
}

export interface CaseExpect {
    exit_code: number | "nonzero";
    stdout?: ContainsRule[];
    stderr?: ContainsRule[];
    ready?: { stdout?: ContainsRule[]; stderr?: ContainsRule[] };
    http?: HttpProbe[];
    ws?: WsProbe[];
    files?: Array<{ path: string; contains?: string; exists?: boolean }>;
    negation?: {
        permissions?: any;
        limits?: any;
    };
}

export interface SequenceStep {
    command?: "webrun" | "host";
    args?: string[];
    env?: Record<string, string>;
    expect: CaseExpect;
}

export interface CaseDefinition {
    name: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    signal?: string;
    timeout_ms?: number;
    runners?: Runner[];
    runner?: Runner;
    steps?: SequenceStep[];
    expect?: CaseExpect;
    expect_webrun?: CaseExpect;
    expect_deno?: CaseExpect;
}

export type DirHandle = any; // FileSystemDirectoryHandle

// ── Case Discovery ───────────────────────────────────────────────────────────

/** Read a text file from a directory handle. */
async function readText(dir: DirHandle, name: string): Promise<string> {
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    return file.text();
}

/** Discover all cases.json files recursively under a directory handle. */
export async function discoverCases(
    rootDir: DirHandle
): Promise<{ dir: DirHandle; def: CaseDefinition }[]> {
    const cases: { dir: DirHandle; def: CaseDefinition }[] = [];
    for await (const [name, handle] of rootDir.entries()) {
        if (handle.kind !== "directory") continue;
        try {
            const raw = await readText(handle, "cases.json");
            const defs: CaseDefinition[] = JSON.parse(raw);
            for (const def of defs) cases.push({ dir: handle, def });
        } catch {
            cases.push(...await discoverCases(handle));
        }
    }
    return cases;
}
