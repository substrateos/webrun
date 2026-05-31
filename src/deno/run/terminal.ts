type TerminalSys = Pick<typeof Deno, 'Command' | 'stdin'>;

export function terminalStateCapture(sys: TerminalSys): string | null {
    try {
        if (!sys.stdin.isTerminal()) return null;
        const cmd = new sys.Command("stty", { args: ["-g"], stdin: "inherit", stdout: "piped", stderr: "piped" });
        const out = cmd.outputSync();
        if (out.code === 0) return new TextDecoder().decode(out.stdout).trim();
    } catch (_) { }
    return null;
}

/**
 * Captures the current terminal state via stty. Restored after sandbox
 * execution to undo any raw-mode changes the guest script made.
 *
 * Host-side lifecycle only — no counterpart in the browser adapter.
 * The browser has no terminal to save/restore.
 */
export function terminalStateRestore(sys: TerminalSys, state: string) {
    try {
        if (!sys.stdin.isTerminal() || !state) return;
        const cmd = new sys.Command("stty", { args: [state], stdin: "inherit", stdout: "piped", stderr: "piped" });
        cmd.outputSync();
    } catch (_) { }
}
