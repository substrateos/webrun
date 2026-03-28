// =========================================================
// Structured log output for user-facing diagnostics.
// Pure functions — zero runtime dependencies.
// =========================================================

export function printUsageError(msg: string) {
    console.error(`[Usage] ${msg}`);
}
export function printWarning(msg: string) {
    console.error(`[Warning] ${msg}`);
}
export function printExecutionError(msg: string, detail?: string) {
    console.error(`[Execution Error] ${msg}`);
    if (detail) console.error(`  ${detail}`);
}
export function printFatalError(msg: string, detail?: string) {
    console.error(`[Fatal] ${msg}`);
    if (detail) console.error(`  ${detail}`);
}
export function printSecurityFatal(msg: string, details?: Record<string, string>) {
    console.error(`[Security Fatal] ${msg}`);
    if (details) {
        for (const [k, v] of Object.entries(details)) {
            console.error(`  ${k.padEnd(10)}: ${v}`);
        }
    }
}
