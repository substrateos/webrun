/**
 * fdlink — connection-oriented IPC over Unix domain sockets
 * with SCM_RIGHTS fd-passing.
 *
 * Public API:
 *   makeFdlink(deps)  — create a Transport
 *   getFd(stream)     — retrieve the raw FD from a stream created by fdlink
 */

export type { Transport, Connection, Listener, Pipe, TransferHandle } from "./types.ts";
export { getFd } from "./types.ts";
export { makeFdlink } from "../../deno/fdlink/unix.ts";
export type { FdlinkDeps } from "../../deno/fdlink/unix.ts";
