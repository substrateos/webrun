import { add } from "@lib/math.ts";
export default async function(ctx) {
    if (add(2, 3) !== 5) throw new Error("Math failed");

    const root = ctx.dir;
    try {
        await root.getFileHandle("shared_lib/math.ts");
    } catch (e) {
        if (e.name === "SecurityError" || e.name === "NotFoundError" || e.name === "TypeError") {
            console.error("BLOCKED:", e.message);
            throw e;
        }
    }
    throw new Error("Breakout succeeded");
}
