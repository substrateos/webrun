// api_opfs_git.test.ts — OPFS git-strategy persistence test.
//
// Requires: git (spawned directly).
// Runner: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/api_opfs_git.test.ts

import { registerTests, sys } from "./_adapter.ts";
import { WEBRUN_BIN } from "./_cli_runner.ts";
import { dirname, join } from "https://deno.land/std@0.224.0/path/mod.ts";

export async function testApiOpfsGit(t: any) {

    await t.run("Experimental OPFS persistence (git strategy)", async () => {
        const tmpApi = sys.realPathSync(sys.makeTempDirSync());

        const run = async (...args: string[]) => {
            const out = await new sys.Command("git", {
                args, cwd: tmpApi, stdout: "null", stderr: "piped",
            }).output();
            if (out.code !== 0) {
                throw new Error(`git ${args[0]} failed (exit ${out.code}): ${new TextDecoder().decode(out.stderr).trim()}`);
            }
            return out;
        };

        await run("init");
        await run("config", "user.name", "test");
        await run("config", "user.email", "test@test.com");
        await run("commit", "--allow-empty", "-m", "init");


        sys.writeTextFileSync(`${tmpApi}/webrun.json`, JSON.stringify({
            experimental: { opfs: { origin: "git" } }
        }));

        sys.writeTextFileSync(`${tmpApi}/write.js`, `
export default async function() {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle("git-opfs.txt", { create: true });
    const writable = await handle.createWritable();
    await writable.write("GIT_OPFS");
    await writable.close();
}`);
        sys.writeTextFileSync(`${tmpApi}/read.js`, `
export default async function() {
    const dir = await navigator.storage.getDirectory();
    try {
        const handle = await dir.getFileHandle("git-opfs.txt");
        const file = await handle.getFile();
        if (await file.text() !== "GIT_OPFS") throw new Error("Mismatch");
    } catch (e) {
        throw new Error("File missing or bad: " + e.message);
    }
}`);

        const wcmd = new sys.Command(WEBRUN_BIN, { args: ["--module", "write.js"], cwd: tmpApi, stdout: "null", stderr: "inherit" });
        const wout = await wcmd.output();
        if (wout.code !== 0) throw new Error("Write failed");

        const rcmd = new sys.Command(WEBRUN_BIN, { args: ["--module", "read.js"], cwd: tmpApi, stdout: "null", stderr: "inherit" });
        const rout = await rcmd.output();
        if (rout.code !== 0) throw new Error("Read failed - OPFS did not persist");

        const badApi = sys.realPathSync(sys.makeTempDirSync());
        sys.writeTextFileSync(`${badApi}/webrun.json`, JSON.stringify({
            experimental: { opfs: { origin: "git" } }
        }));
        sys.writeTextFileSync(`${badApi}/write.js`, `export default async function() {}`);

        const errcmd = new sys.Command(WEBRUN_BIN, { args: ["--module", "write.js"], cwd: badApi, stdout: "null", stderr: "piped" });
        const errout = await errcmd.output();
        if (errout.code === 0) throw new Error("Expected git error boundary to enforce fatal crash, but it succeeded.");
        const stderrStr = new TextDecoder().decode(errout.stderr);
        if (!stderrStr.includes("requires a valid git repository")) throw new Error("Missing fatal git origin error log: " + stderrStr);
    });
}

import * as self from "./api_opfs_git.test.ts";
registerTests(self);
