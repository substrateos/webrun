import { add } from "@lib/math.ts";
export default async function(ctx) {
    if (add(2, 3) !== 5) throw new Error("Math failed");
    console.log("IMPORT_SUCCESS");
}
