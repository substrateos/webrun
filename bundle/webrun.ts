/**
 * Master build script — produces the complete self-contained `webrun`
 * executable to stdout.
 *
 * Usage: deno run -A --no-check bundle/webrun.ts
 *
 * Steps:
 * 1. Read the shell preamble from ./webrun (everything before __DATA__, or all if absent)
 * 2. Bundle webrun.ts → webrun.js via bundle/main.ts
 * 3. Bundle worker blob via bundle/inline.ts --raw
 * 4. Compute SHA-256 of each artifact
 * 5. Patch preamble placeholders with real values (SHAs, byte offsets, sizes)
 * 6. Emit: patched preamble + __DATA__ + main JS + __WORKER_DATA__ + worker JS
 *         + __README_DATA__ + README + __LICENSE_DATA__ + LICENSE
 *         + __DENO_JSON_DATA__ + deno.json + __DENO_LOCK_DATA__ + deno.lock
 */

import * as esbuild from "https://deno.land/x/esbuild@v0.20.1/mod.js";
import { readTextFile } from "../src/core/io.ts";
import { build as bundleMain } from "./main.ts";
import { build as bundleInline } from "./inline.ts";
import { build as bundleWebRTC } from "./webrtc.ts";

const encoder = new TextEncoder();

async function sha256hex(data: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function readFile(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array> {
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
}

interface BundleCtx {
    dir: FileSystemDirectoryHandle;
    resolveHandle(handle: FileSystemHandle): string;
}

export async function build(_args: string[], _env: Record<string, string>, ctx: BundleCtx): Promise<Uint8Array> {
    // Read the shell preamble
    const preamble = await readTextFile(ctx.dir, ["src", "webrun.preamble.sh"]);

    // Bundle main JS
    const mainStr = await bundleMain([], {}, ctx);
    const mainJS = encoder.encode(mainStr);
    const mainSha = await sha256hex(mainJS);

    // Bundle worker JS
    const workerStr = await bundleInline("src/deno/worker/worker.ts", ctx);
    const workerJS = encoder.encode(workerStr);
    const workerSha = await sha256hex(workerJS);

    // Bundle test adapter JS
    const testAdapterStr = await bundleInline("src/deno/test/webrun.ts", ctx);
    const testAdapterJS = encoder.encode(testAdapterStr);
    const testAdapterSha = await sha256hex(testAdapterJS);

    // Bundle WEBRTC dynamically
    const webrtcStr = await bundleWebRTC([], {}, ctx);
    const webrtcJS = encoder.encode(webrtcStr);
    const webrtcSha = await sha256hex(webrtcJS);

    // Read metadata files
    const readme = await readFile(ctx.dir, "README.md");
    const license = await readFile(ctx.dir, "LICENSE");
    const denoJson = await readFile(ctx.dir, "deno.json");
    const denoLock = await readFile(ctx.dir, "deno.lock");

    // 6. Compute byte offsets
    // Layout: preamble + __DATA__\n + mainJS + __WORKER_DATA__\n + workerJS
    //         + __TEST_ADAPTER_DATA__\n + testAdapterJS
    //         + __README_DATA__\n + readme + __LICENSE_DATA__\n + license
    //         + __DENO_JSON_DATA__\n + denoJson + __DENO_LOCK_DATA__\n + denoLock
    //
    // We need to know the preamble size AFTER patching, but the preamble size
    // depends on the SHA/offset values we embed. We solve this by using fixed-width
    // placeholders that get replaced with same-length values.

    // First pass: measure with placeholder values to get sizes
    const dataMarker = encoder.encode("__DATA__\n");
    const workerMarker = encoder.encode("__WORKER_DATA__\n");
    const testAdapterMarker = encoder.encode("__TEST_ADAPTER_DATA__\n");
    const webrtcMarker = encoder.encode("__WEBRTC_DATA__\n");

    // Preamble patching: replace placeholder values
    let patched = preamble;
    patched = patched.replace(/^MAIN_SHA=.*$/m, `MAIN_SHA=${mainSha}`);
    patched = patched.replace(/^WORKER_SHA=.*$/m, `WORKER_SHA=${workerSha}`);
    patched = patched.replace(/^TEST_ADAPTER_SHA=.*$/m, `TEST_ADAPTER_SHA=${testAdapterSha}`);
    patched = patched.replace(/^WEBRTC_SHA=.*$/m, `WEBRTC_SHA=${webrtcSha}`);

    // Compute offsets relative to start of file
    let preambleBytes = encoder.encode(patched);
    let curMainOffset = preambleBytes.length + dataMarker.length;
    let curWorkerOffset = curMainOffset + mainJS.length + workerMarker.length;
    let curTestAdapterOffset = curWorkerOffset + workerJS.length + testAdapterMarker.length;
    let curWebrtcOffset = curTestAdapterOffset + testAdapterJS.length + webrtcMarker.length;

    // Iterate until stable: patching offset values into the preamble may change
    // the preamble's byte length, which shifts the offsets.
    for (let i = 0; i < 10; i++) {
        patched = patched.replace(/^MAIN_OFFSET=.*$/m, `MAIN_OFFSET=${curMainOffset}`);
        patched = patched.replace(/^MAIN_SIZE=.*$/m, `MAIN_SIZE=${mainJS.length}`);
        patched = patched.replace(/^WORKER_OFFSET=.*$/m, `WORKER_OFFSET=${curWorkerOffset}`);
        patched = patched.replace(/^WORKER_SIZE=.*$/m, `WORKER_SIZE=${workerJS.length}`);
        patched = patched.replace(/^TEST_ADAPTER_OFFSET=.*$/m, `TEST_ADAPTER_OFFSET=${curTestAdapterOffset}`);
        patched = patched.replace(/^TEST_ADAPTER_SIZE=.*$/m, `TEST_ADAPTER_SIZE=${testAdapterJS.length}`);
        patched = patched.replace(/^WEBRTC_OFFSET=.*$/m, `WEBRTC_OFFSET=${curWebrtcOffset}`);
        patched = patched.replace(/^WEBRTC_SIZE=.*$/m, `WEBRTC_SIZE=${webrtcJS.length}`);

        preambleBytes = encoder.encode(patched);
        const newMainOffset = preambleBytes.length + dataMarker.length;
        const newWorkerOffset = newMainOffset + mainJS.length + workerMarker.length;
        const newTestAdapterOffset = newWorkerOffset + workerJS.length + testAdapterMarker.length;
        const newWebrtcOffset = newTestAdapterOffset + testAdapterJS.length + webrtcMarker.length;
        if (newMainOffset === curMainOffset && newWorkerOffset === curWorkerOffset && newTestAdapterOffset === curTestAdapterOffset && newWebrtcOffset === curWebrtcOffset) break;
        curMainOffset = newMainOffset;
        curWorkerOffset = newWorkerOffset;
        curTestAdapterOffset = newTestAdapterOffset;
        curWebrtcOffset = newWebrtcOffset;
    }

    // Assemble
    const segments: Uint8Array[] = [
        encoder.encode(patched),
        dataMarker,
        mainJS,
        workerMarker,
        workerJS,
        testAdapterMarker,
        testAdapterJS,
        webrtcMarker,
        webrtcJS,
        encoder.encode("__README_DATA__\n"),
        readme,
        encoder.encode("__LICENSE_DATA__\n"),
        license,
        encoder.encode("__DENO_JSON_DATA__\n"),
        denoJson,
        encoder.encode("__DENO_LOCK_DATA__\n"),
        denoLock,
    ];
    const total = segments.reduce((n, s) => n + s.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const seg of segments) {
        result.set(seg, offset);
        offset += seg.length;
    }
    return result;
}

async function main(args: string[], env: Record<string, string>, ctx: BundleCtx): Promise<void> {
    const data = await build(args, env, ctx);
    esbuild.stop();
    await Deno.stdout.write(data);
}

export default { main };

if (import.meta.main) {
    const createFS = (await import("../src/deno/file_system/mod.ts")).default;
    const fs = createFS(globalThis.Deno as any);
    const dir = new fs.FileSystemDirectoryHandle(Deno.cwd(), ".");
    const ctx: BundleCtx = { dir, resolveHandle: fs.resolveHandle };
    await main(Deno.args, Deno.env.toObject(), ctx);
}
