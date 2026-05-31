import { makeSeatbelt } from "./mod.ts";

const { querySeatbeltSupport } = makeSeatbelt({
    dlopen: Deno.dlopen,
    UnsafePointer: Deno.UnsafePointer,
    UnsafePointerView: Deno.UnsafePointerView,
});

export async function testSeatbeltSupport(t: any) {
    await t.run("querySeatbeltSupport returns true on darwin", async () => {
        if (Deno.build.os !== "darwin") return; // skip on non-darwin
        if (!querySeatbeltSupport()) {
            throw new Error("querySeatbeltSupport() returned false on darwin");
        }
    });

    await t.run("querySeatbeltSupport fails if sandbox_init_with_parameters cannot be loaded", async () => {
        const { querySeatbeltSupport: queryFailingSeatbelt } = makeSeatbelt({
            dlopen: () => { throw new Error("Simulated dlopen failure"); },
            UnsafePointer: Deno.UnsafePointer,
            UnsafePointerView: Deno.UnsafePointerView,
        });

        let didThrow = false;
        try {
            queryFailingSeatbelt();
        } catch (e: any) {
            if (e.message.includes("Simulated dlopen failure")) {
                didThrow = true;
            }
        }
        if (!didThrow) {
            throw new Error("Expected querySeatbeltSupport to throw on load failure");
        }
    });
}
