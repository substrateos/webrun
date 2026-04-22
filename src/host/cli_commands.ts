import { resolve, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { printWarning } from "../log.ts";
import { resolveWebrunEntryPath } from "../sys.ts";
import type { HostRuntime } from "../types.ts";

export async function handleCliCommands(sys: HostRuntime, args: string[], projectRoot: string) {
    const webrunFlags: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--") break;
        if (!arg.startsWith("-")) break;
        webrunFlags.push(arg);
        if (arg === "--eval" || arg === "-e") break;
        if (arg === "--self-unbundle") {
            if (i + 1 < args.length) webrunFlags.push(args[++i]);
        }
    }

    if (webrunFlags.includes("--version") || webrunFlags.includes("-v")) {
        console.log(`webrun ${sys.env.get("WEBRUN_VERSION") || "dev"}`);
        sys.exit(0);
    }

    const hasSelfTest = webrunFlags.some(f => f === "--self-test" || f.startsWith("--self-test="));
    if (webrunFlags.includes("--self-check") || hasSelfTest) {
        const checkCmd = new sys.Command(sys.execPath(), {
            args: ["check", resolveWebrunEntryPath(sys, import.meta.url)],
            stdout: "inherit",
            stderr: "inherit"
        });
        const status = await checkCmd.output();
        if (status.code !== 0 || !hasSelfTest) {
            sys.exit(status.code);
        }
    }

    if (webrunFlags.includes("--help") || webrunFlags.includes("-h")) {
        try {
            const selfPath = sys.env.get("WEBRUN_BIN") || sys.execPath();
            let readmeContent = sys.readTextFileSync(selfPath);
            const isBundled = !!readmeContent.match(/^__README_DATA__\s*$/m);
            if (isBundled) {
                readmeContent = readmeContent.split(/^__README_DATA__\s*$/m)[1].split(/^__LICENSE_DATA__\s*$/m)[0];
            } else {
                readmeContent = sys.readTextFileSync(resolve(dirname(selfPath), "README.md"));
            }

            const selfCommands = isBundled ?
                `  --self-unbundle <dest>  Extract the webrun source files from the executable into a folder for editing` :
                `  --self-bundle           Package the webrun source files into a single executable file
  --self-vendor           Download all dependencies into the local cache`;

            console.log(`Usage: webrun [options] [args...]

Options:
  -h, --help              Print the usage instructions
  -v, --version           Print the version information
  -e, --eval <code>       Evaluate the given code instead of reading from a file
  --module <name>         Explicitly set the execution entrypoint using a mapped module name
  --test[=<filter>]       Run test suites (with optional name filter)
  --check-only            Perform type checking on the target script without executing it
  --no-check              Skip TypeScript type checking
  --self-test[=<filter>]  Run the built-in test suite (with optional suite filter)
${selfCommands}`);
            const contractMatch = readmeContent.match(/## API[^\n]*\n+([\s\S]*?)(\n## |$)/i);
            if (contractMatch && contractMatch[1]) {
                console.log("==========================================");
                console.log("WEBRUN API CONTRACT");
                console.log("==========================================");
                console.log(contractMatch[1].trim());
            }
        } catch (_) {
            printWarning("Documentation unavailable.");
        }
        sys.exit(0);
    }
}
