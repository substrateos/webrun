import { sys } from "./src/sys.ts";
import { spawnSandboxProcess } from "./src/execution.ts";
export { executeInsideSandbox } from "./src/execution.ts";
export { parseRawArguments } from "./src/config.ts";

// =========================================================
// 5. GLOBAL ENTRYPOINT EVALUATION
// =========================================================

if (import.meta.main) {
    await spawnSandboxProcess(sys.cwd(), sys.args);
}
