import { tty } from "webrun/ctx";

export default async function() {
    // Verify tty is importable from webrun/ctx (may be undefined or an object)
    if (tty === undefined || (typeof tty === "object" && tty !== null)) {
        console.log("TTY_IMPORT_OK");
    } else {
        throw new Error("Expected tty import to be undefined or object, got " + typeof tty);
    }
}
