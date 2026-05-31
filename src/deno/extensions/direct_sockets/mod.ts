/**
 * @webrun/deno/direct_sockets — Direct Sockets extension.
 *
 * Captures Deno.connect before scrub and provides ctx.TCPSocket
 * when permissions.tcp is granted. Must run before @webrun/deno/scrub.
 */
import type { Extension } from "../../../extensions/mod.ts";
import { makeDirectSockets } from "../../direct_sockets/mod.ts";

const directSocketsExt: Extension = async (ctx, next) => {
    const Deno = (globalThis as any).Deno;

    if (ctx.permissions?.tcp && typeof Deno?.connect === "function") {
        const { TCPSocket } = makeDirectSockets({ connect: Deno.connect.bind(Deno) });
        ctx = { ...ctx, TCPSocket };
    }

    await next(ctx);
};

export default directSocketsExt;
