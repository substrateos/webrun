import { p } from "parent-mod";
import { c } from "child-mod";
import { s } from "shared";
export default function() {
    if (p !== 1) throw new Error("Parent missing");
    if (c !== 2) throw new Error("Child missing");
    if (s !== 2) throw new Error("Child did not override parent shared");
    console.log("MERGED_OK");
}
