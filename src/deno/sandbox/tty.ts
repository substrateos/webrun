/**
 * makeTTY — Deno adapter for terminal (TTY) access.
 *
 * Returns a TTY handle if stdin is a terminal, null otherwise.
 */

interface TTYDeps {
    stdin: { isTerminal(): boolean; setRaw(raw: boolean, options?: { cbreak: boolean }): void };
    consoleSize(): { columns: number; rows: number };
}

export interface TTY {
    setRawMode(raw: boolean): Promise<void>;
    isRaw(): Promise<boolean>;
    consoleSize(): Promise<{ columns: number; rows: number }>;
}

export default function makeTTY(deps: TTYDeps): TTY | null {
    let isTerminal = false;
    try { isTerminal = deps.stdin.isTerminal(); } catch (_) { return null; }
    if (!isTerminal) return null;

    let rawMode = false;
    return {
        async setRawMode(raw: boolean): Promise<void> {
            deps.stdin.setRaw(raw, { cbreak: true });
            rawMode = raw;
        },
        async isRaw(): Promise<boolean> { return rawMode; },
        async consoleSize(): Promise<{ columns: number; rows: number }> { return deps.consoleSize(); },
    };
}
