// extensions/mod.ts — WebRun extension system.
//
// Extensions are Koa-style middleware that transform the Context
// before the guest process runs. Each extension receives (ctx, next, config)
// and can modify ctx, short-circuit by not calling next, or do post-processing.
//
// Built-in extensions use the @webrun/ namespace in config keys
// (e.g., "@webrun/check") and are statically imported.

import type { Context, ExtensionContext } from "../core/types.ts";

/**
 * A WebRun extension — Koa-style middleware.
 *
 * Receives the execution context and a `next` function.
 * Can transform ctx before calling next (pre-processing),
 * do post-processing after next returns,
 * or short-circuit by not calling next.
 *
 * Normal return = exit 0. Non-zero exit uses ctx.exit(n).
 *
 * Extensions receive ONLY the standard Context — no adapter-specific
 * deps, no runtime objects. If an extension needs a capability, that
 * capability must exist on ctx.
 */
export type Extension = (
    ctx: ExtensionContext,
    next: (ctx: Context) => Promise<void>,
    config: Record<string, unknown>,
) => Promise<void>;

/**
 * Resolves an ordered list of extensions from the config's extensions key.
 * Object key order determines execution order.
 *
 *
 * Built-in extensions (@webrun/<name>) are statically imported.
 */
export async function resolveExtensions(
    extensionsConfig: Record<string, Record<string, unknown>>,
): Promise<{ ext: Extension; config: Record<string, unknown>; key: string }[]> {
    const entries = Object.entries(extensionsConfig);
    if (entries.length === 0) return [];

    return Promise.all(
        entries.map(async ([key, config]) => {
            const ext = await loadExtension(key);
            return { ext, config, key };
        }),
    );
}

const BUILTIN_PREFIX = "@webrun/";

import checkExt from "./check/mod.ts";
import htmlExt from "./html/mod.ts";
import opfsExt from "./opfs/mod.ts";
import testExt from "./test/mod.ts";

// Deno adapter privileged extensions
import denoMemoryExt from "../deno/extensions/memory/mod.ts";
import denoNavigatorExt from "../deno/extensions/navigator/mod.ts";
import denoPerfExt from "../deno/extensions/perf/mod.ts";
import denoScrubExt from "../deno/extensions/scrub/mod.ts";
import denoServeExt from "../deno/extensions/serve/mod.ts";
import denoWebrtcExt from "../deno/extensions/webrtc/mod.ts";
import denoDirectSocketsExt from "../deno/extensions/direct_sockets/mod.ts";
import denoFileSystemExt from "../deno/extensions/file_system/mod.ts";

/**
 * Loads an extension by key.
 *
 * @webrun/<name> keys resolve to the built-in extensions.
 * They are statically imported so that `deno compile` can bundle them.
 */
async function loadExtension(key: string): Promise<Extension> {
    if (!key.startsWith(BUILTIN_PREFIX)) {
        throw new Error(`User extensions are not yet supported: ${key}`);
    }

    const name = key.slice(BUILTIN_PREFIX.length);
    switch (name) {
        case "check": return checkExt;
        case "html": return htmlExt;
        case "opfs": return opfsExt;
        case "test": return testExt;
        case "deno/memory": return denoMemoryExt;
        case "deno/navigator": return denoNavigatorExt;
        case "deno/perf": return denoPerfExt;
        case "deno/scrub": return denoScrubExt;
        case "deno/serve": return denoServeExt;
        case "deno/webrtc": return denoWebrtcExt;
        case "deno/direct_sockets": return denoDirectSocketsExt;
        case "deno/file_system": return denoFileSystemExt;
        default:
            throw new Error(`Unknown built-in extension: ${key}`);
    }
}
