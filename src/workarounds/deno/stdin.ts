/**
 * Workaround: Deno stdin EAGAIN on macOS raw TTY mode.
 *
 * When Deno.stdin.setRaw(true) is called on macOS, the runtime sets
 * O_NONBLOCK on fd 0 via fcntl(). Deno's Tokio event loop registers the
 * fd with kqueue and parks until readiness is signaled. However, there is
 * a narrow race at the raw-mode transition boundary: kqueue may report
 * readiness while the kernel input buffer is still empty, causing the
 * subsequent read() syscall to return EAGAIN (os error 11).
 *
 * This is fatal for Deno.stdin.readable (the W3C ReadableStream wrapper)
 * because the W3C Streams spec mandates that any error in pull()
 * permanently transitions the stream to an "errored" state. A single
 * transient EAGAIN destroys the stream for the lifetime of the process.
 *
 * This module provides a replacement ReadableStream that uses the
 * stateless Deno.stdin.read(buf) API instead. Because read() has no
 * internal stream state, catching EAGAIN and retrying is safe — the outer
 * ReadableStream never sees the transient error.
 *
 * Lifecycle: This workaround can be removed if Deno's native stream
 * adapter gains internal EAGAIN retry logic for non-blocking TTY fds.
 * Track: https://github.com/denoland/deno/issues (search "EAGAIN stdin raw")
 */

/**
 * Backoff delay (ms) between EAGAIN retries.
 *
 * This is not a steady-state polling interval. After the setRaw transition
 * settles (typically 0–2 EAGAIN hits), Deno.stdin.read() parks correctly
 * on kqueue and the retry path stops firing.
 */
const EAGAIN_BACKOFF_MS = 10;

/**
 * Wraps a Deno stdin resource in a ReadableStream that survives EAGAIN.
 *
 * Falls through to the native .readable if the resource lacks a .read()
 * method (e.g., when running on a future runtime that doesn't expose it).
 * Returns null if stdin is not available.
 *
 * pull() is only invoked lazily when a consumer calls reader.read(),
 * so idle streams consume zero CPU.
 */
export function createResilientStdinStream(stdin?: { readable?: ReadableStream; read?: (buf: Uint8Array) => Promise<number | null> }): ReadableStream | null {
    if (!stdin) return null;
    if (typeof stdin.read !== "function") return stdin.readable || null;

    const read = stdin.read.bind(stdin);

    return new ReadableStream({
        async pull(controller) {
            const buf = new Uint8Array(1024);
            while (true) {
                try {
                    const n = await read(buf);
                    if (n === null || n === 0) {
                        controller.close();
                    } else {
                        controller.enqueue(buf.slice(0, n));
                    }
                    return;
                } catch (e: unknown) {
                    const err = e as { message?: string; code?: string; name?: string };
                    if (err.message?.includes("os error 11") || err.code === "EAGAIN" || err.name === "WouldBlock") {
                        await new Promise(r => setTimeout(r, EAGAIN_BACKOFF_MS));
                        continue;
                    }
                    controller.error(e);
                    return;
                }
            }
        }
    }, { highWaterMark: 0 });
}
