export async function testCliPty(t: any) {
    await t.run("createResilientStdinStream absorbs EAGAIN without poisoning the stream", async () => {
        const { createResilientStdinStream } = await import("../src/workarounds/deno/stdin.ts");

        let callCount = 0;
        const fakeStdin = {
            read(buf: Uint8Array) {
                callCount++;
                if (callCount <= 2) {
                    return Promise.reject(new Error("Resource temporarily unavailable (os error 11)"));
                }
                // Third call succeeds with "x"
                buf[0] = 0x78; // 'x'
                return Promise.resolve(1);
            }
        };

        const stream = createResilientStdinStream(fakeStdin as any);
        if (!stream) throw new Error("Expected stream, got null");

        const reader = stream.getReader();
        const { value, done } = await reader.read();
        if (done) throw new Error("Stream closed unexpectedly");
        if (new TextDecoder().decode(value) !== "x") {
            throw new Error("Expected 'x', got: " + new TextDecoder().decode(value));
        }
        if (callCount !== 3) {
            throw new Error("Expected 3 read attempts (2 EAGAIN + 1 success), got " + callCount);
        }
        reader.releaseLock();
    });

    await t.run("createResilientStdinStream propagates non-EAGAIN errors", async () => {
        const { createResilientStdinStream } = await import("../src/workarounds/deno/stdin.ts");

        const fakeStdin = {
            read(_buf: Uint8Array) {
                return Promise.reject(new Error("Permission denied"));
            }
        };

        const stream = createResilientStdinStream(fakeStdin as any);
        if (!stream) throw new Error("Expected stream, got null");

        const reader = stream.getReader();
        try {
            await reader.read();
            throw new Error("Expected error, but read succeeded");
        } catch (e: any) {
            if (!e.message.includes("Permission denied")) {
                throw new Error("Expected 'Permission denied', got: " + e.message);
            }
        }
    });

    await t.run("createResilientStdinStream returns null for missing stdin", async () => {
        const { createResilientStdinStream } = await import("../src/workarounds/deno/stdin.ts");
        if (createResilientStdinStream(undefined) !== null) {
            throw new Error("Expected null for undefined stdin");
        }
    });

    await t.run("createResilientStdinStream falls through to .readable when .read is absent", async () => {
        const { createResilientStdinStream } = await import("../src/workarounds/deno/stdin.ts");

        const sentinel = new ReadableStream();
        const fakeStdin = { readable: sentinel };
        const result = createResilientStdinStream(fakeStdin as any);
        if (result !== sentinel) {
            throw new Error("Expected fallthrough to .readable");
        }
    });

    await t.run("createResilientStdinStream closes on EOF (null read)", async () => {
        const { createResilientStdinStream } = await import("../src/workarounds/deno/stdin.ts");

        const fakeStdin = {
            read(_buf: Uint8Array) {
                return Promise.resolve(null);
            }
        };

        const stream = createResilientStdinStream(fakeStdin as any);
        if (!stream) throw new Error("Expected stream, got null");

        const reader = stream.getReader();
        const { done } = await reader.read();
        if (!done) throw new Error("Expected stream to close on null read");
    });
}
