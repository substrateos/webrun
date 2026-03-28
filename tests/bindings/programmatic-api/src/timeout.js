import { webrun } from "webrun/ctx";
export default async function(ctx) {
    const res = await webrun(["--eval", "while(true){}"], { timeoutMillis: 50 });
    if (res.exitCode !== 143) throw new Error("webrun timeout failed to abort");
    console.log("TIMEOUT_OK");
}
