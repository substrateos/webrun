/**
 * UA Proxy — webrun module entry point.
 *
 * Spawned by the host as a direct Deno subprocess via the
 * --internal-webrun-proxy dispatch in webrun.ts.
 *
 * Uses the Node serve adapter (via Deno's Node compat layer)
 * because it supports CONNECT tunnels for HTTPS MITM proxying.
 * The Deno serve adapter does not implement upgradeConnect.
 *
 * Requires: direct Deno process (not Worker sandbox — node:tls
 * needs Deno globals).
 */

import { startUAProxy } from "./mod.ts";
import { makeServe } from "../node/serve/mod.ts";
import { makeDirectSockets } from "../deno/direct_sockets/mod.ts";
import type { Context } from "../core/types.ts";
import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import * as net from "node:net";

export default {
    async main(_args: string[], _env: Record<string, string>, ctx: Context) {
        const serve = makeServe({ node: { http, https, tls, net } });
        const { TCPSocket } = makeDirectSockets({ connect: Deno.connect.bind(Deno) });
        const proxy = await startUAProxy({ serve, TCPSocket });

        console.log(JSON.stringify({ port: proxy.port, caCertPem: proxy.caCertPem }));

        await new Promise<void>((resolve) => {
            ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });

        await proxy.shutdown();
    },
};
