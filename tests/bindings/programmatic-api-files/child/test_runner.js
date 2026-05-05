import { webrun } from "webrun/ctx";
export default async function(ctx) {
    const result = await webrun(["--test", "suite.test.ts"]);
    if (result.exitCode !== 0) {
        throw new Error(`Sub-worker test suite failed with exit ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    }
    console.log("TEST_OK");
}
