import type { BundleInfo } from "../bundle.ts";
import type { WebrunLimits } from "../types.ts";

/** Webrun's own flags (before the target script). */
export interface WebrunFlags {
    serve?: boolean;
    bind?: string
    test?: string | boolean;
    "check-only"?: boolean;
    "no-check"?: boolean;
    help?: boolean;
    version?: boolean;
    v?: boolean;
    e?: boolean;
    eval?: boolean;
    dir?: string;
    "limit-time"?: string;
    "limit-memory"?: string;
}

export interface ParsedArgs {
    /** Webrun's own flags — everything before the target. */
    flags: WebrunFlags;

    /** First positional arg — the execution target. */
    target: string;

    /** Positional args after the target (or after --) — passed through to ctx.args. */
    guestArgs: string[];

    /** Whether this is a serve invocation. */
    isServe: boolean;

    /** Resolved serve URLs from --bind/--listen flags. */
    serveUrls: string[];

    /** Parsed resource limits from --limit-time / --limit-memory. */
    limits: WebrunLimits;
}

/** Parse a flag arg: --key=value splits on =, bare --key is boolean true. */
export function parseFlag(args: string[], i: number): [string, string | boolean, number] {
    const arg = args[i];
    const key = arg.replace(/^-+/, "");
    const eqIdx = key.indexOf("=");
    if (eqIdx !== -1) {
        return [key.slice(0, eqIdx), key.slice(eqIdx + 1), i];
    }
    return [key, true, i];
}

function parse(args: string[], env: Record<string, string>): ParsedArgs {
    const flags: WebrunFlags = {};
    let target = "";
    const guestArgs: string[] = [];
    let phase: "pre" | "post" = "pre";

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (phase === "post") { guestArgs.push(arg); continue; }
        if (arg === "--") {
            if (!target) {
                // POSIX: first arg after -- becomes the target when no target was found yet
                const next = args[i + 1];
                if (next !== undefined) { target = next; i++; }
            }
            phase = "post";
            continue;
        }

        if (arg.startsWith("-")) {
            const [key, val, newI] = parseFlag(args, i);
            if (typeof val === "boolean") {
                if (key === "serve") flags.serve = val;
                else if (key === "check-only") flags["check-only"] = val;
                else if (key === "no-check") flags["no-check"] = val;
                else if (key === "help") flags.help = val;
                else if (key === "h") flags.help = val;
                else if (key === "version") flags.version = val;
                else if (key === "v") flags.v = val;
                else if (key === "e") flags.e = val;
                else if (key === "eval") flags.eval = val;
                else if (key === "test") flags.test = val;
                else throw new Error(`Unknown boolean flag: ${key}`);
            } else {
                if (key === "bind") flags.bind = val;
                else if (key === "dir") flags.dir = val;
                else if (key === "limit-time") flags["limit-time"] = val;
                else if (key === "limit-memory") flags["limit-memory"] = val;
                else if (key === "test") flags.test = val;
                else throw new Error(`Unknown string flag: ${key}`);
            }
            i = newI;
            continue;
        }

        target = arg;
        phase = "post";
    }

    const isServe = !!(flags.serve || flags.bind);
    const serveUrls: string[] = [];
    const key = "bind" as const
    const val = flags[key];
    if (typeof val === "string") {
        let host = "127.0.0.1", port = 0;
        if (val.startsWith(":")) { port = parseInt(val.slice(1), 10); }
        else if (val.includes(":")) { const p = val.split(":"); host = p[0]; port = parseInt(p[1], 10); }
        else { host = val; }
        serveUrls.push(`http://${host}:${port}`);
    }
    if (isServe && serveUrls.length === 0) {
        let port = 0;
        const portEnv = env["PORT"]
        if (portEnv && /^\d+$/.test(portEnv)) port = parseInt(portEnv, 10);
        serveUrls.push(`http://127.0.0.1:${port}`);
    }

    // -e / --eval: the target is inline code, not a file path.
    // If the code already provides its own default export, use it as-is.
    // Otherwise run it as top-level code with a no-op default export appended.
    // Note: empty code is a valid payload (clean exit, no-op module).
    if (flags.e || flags.eval) {
        const code = target.trimStart();
        const wrappedCode = code.startsWith("export default ") ? code : `${code}\nexport default { main() {} };`;
        target = `data:application/typescript;charset=utf-8,${encodeURIComponent(wrappedCode)}`;
    }

    const limits: WebrunLimits = {};
    const rawTime = flags["limit-time"];
    const rawMem = flags["limit-memory"];
    if (typeof rawTime === "string") limits.timeoutMillis = parseInt(rawTime, 10);
    if (typeof rawMem === "string") limits.memoryMB = parseInt(rawMem, 10);

    return { flags, target, guestArgs, isServe, serveUrls, limits };
}

interface CliDeps {
    bundle: BundleInfo;
    readReadme?: () => Promise<string | undefined>;
    console: Pick<Console, "log" | "error">;
    exit: (code: number) => never;
}

async function handle(parsed: ParsedArgs, deps: CliDeps) {
    const { flags: pre } = parsed;

    if (pre.version || pre.v) {
        deps.console.log(`webrun ${deps.bundle.version}`);
        deps.exit(0);
    }

    if (pre.help) {
        const selfCommands = `  --self-unbundle=<dest>  Extract the webrun source files from the executable into a folder for editing`;

        deps.console.log(`Usage: webrun [options] [args...]

Options:
  -h, --help              Print the usage instructions
  -v, --version           Print the version information
  -e, --eval              Evaluate the target as inline code instead of a file path

  --test[=<filter>]       Run test suites (with optional name filter)
  --check-only            Perform type checking on the target script without executing it
  --no-check              Skip TypeScript type checking

${selfCommands}`);

        try {
            const readme = await deps.readReadme?.();
            if (readme) {
                const contractMatch = readme.match(/## API[^\n]*\n+([\s\S]*?)(\n## |$)/i);
                if (contractMatch && contractMatch[1]) {
                    deps.console.log("==========================================");
                    deps.console.log("WEBRUN API CONTRACT");
                    deps.console.log("==========================================");
                    deps.console.log(contractMatch[1].trim());
                }
            }
        } catch (_) {
            deps.console.error("[Warning] Documentation unavailable.");
        }
        deps.exit(0);
    }
}

export default async function (args: string[], env: Record<string, string>, deps: CliDeps) {
    const parsed = parse(args, env);
    await handle(parsed, deps);
    return parsed
}