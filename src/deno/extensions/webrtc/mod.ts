/**
 * @webrun/deno/webrtc — WebRTC bootstrap extension.
 *
 * Captures Node.js globals (Buffer, process, setImmediate, clearImmediate)
 * before they are scrubbed, then dynamically imports the WebRTC polyfill.
 * Must run before @webrun/deno/scrub in the cascade.
 */
import type { Extension } from "../../../extensions/mod.ts";

const webrtcExt: Extension = async (ctx, next, config) => {
    const udpPort = (config as any).udpPort;
    const bundlePath = (config as any).bundlePath;
    if (!udpPort || !bundlePath) return next(ctx);

    const savedBuffer = (globalThis as any).Buffer;
    const savedSetImmediate = (globalThis as any).setImmediate;
    const savedClearImmediate = (globalThis as any).clearImmediate;
    const savedProcess = (globalThis as any).process;
    const savedNetworkInterfaces = (globalThis as any).Deno?.networkInterfaces;

    const { bootstrapWebRTC } = await import("./webrtc_polyfill.ts");
    await bootstrapWebRTC(bundlePath, {
        udpPort,
        Buffer: savedBuffer,
        setImmediate: savedSetImmediate,
        clearImmediate: savedClearImmediate,
        process: savedProcess,
        networkInterfaces: savedNetworkInterfaces,
    });

    return next(ctx);
};

export default webrtcExt;
