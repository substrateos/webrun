import { webrun } from "webrun/ctx";
export default async function(ctx) {
    let blocked = false;
    try {
        await webrun(["--test", "--module", "suite.test.ts"]);
    } catch (e) {
        if (e.message.includes("not yet implemented")) blocked = true;
    }
    if (!blocked) throw new Error("webrun failed to block --test");
    console.log("TEST_OK");
}
