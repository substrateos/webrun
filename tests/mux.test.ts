import { timingSafeEqual } from "../src/mux.ts";

export async function testMux(t: any) {
    const equalCases = [
        { name: "identical bytes → true",  a: "hello", b: "hello", expect: true },
        { name: "different bytes → false", a: "hello", b: "world", expect: false },
        { name: "different length → false", a: "hi",    b: "hello", expect: false },
        { name: "empty arrays → true",     a: "",      b: "",      expect: true },
        { name: "single char match",       a: "a",     b: "a",     expect: true },
        { name: "single char mismatch",    a: "a",     b: "b",     expect: false },
    ];

    const enc = new TextEncoder();
    for (const tc of equalCases) {
        await t.run(`timingSafeEqual: ${tc.name}`, async () => {
            const result = timingSafeEqual(enc.encode(tc.a), enc.encode(tc.b));
            if (result !== tc.expect) {
                throw new Error(`Expected ${tc.expect}, got ${result}`);
            }
        });
    }
}
