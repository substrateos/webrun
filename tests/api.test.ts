import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

import { discoverCases, runBatchCase, runSignalCase } from "./case_runner.ts";

export async function testApi(t: any) {
    const thisDir = dirname(new URL(import.meta.url).pathname);
    const cases = discoverCases(t, join(thisDir, "api"));
    if (cases.length === 0) throw new Error("No API test cases discovered");

    for (const { dir, def } of cases) {
        await t.run(def.name, async () => {
            if (def.signal) {
                await runSignalCase(t, dir, def);
            } else {
                await runBatchCase(t, dir, def);
            }
        });
    }

    await t.run("Experimental OPFS persistence (path strategy)", async () => {
        const tmpApi = t.testsys.realPathSync(t.testsys.makeTempDirSync());
        t.testsys.writeTextFileSync(`${tmpApi}/webrun.json`, JSON.stringify({
            experimental: { opfs: { origin: "path" } }
        }));
        
        t.testsys.writeTextFileSync(`${tmpApi}/write.js`, `
export default async function() {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle("persisted.txt", { create: true });
    const writable = await handle.createWritable();
    await writable.write("HELLOOO");
    await writable.close();
}`);
        t.testsys.writeTextFileSync(`${tmpApi}/read.js`, `
export default async function() {
    const dir = await navigator.storage.getDirectory();
    try {
        const handle = await dir.getFileHandle("persisted.txt");
        const file = await handle.getFile();
        if (await file.text() !== "HELLOOO") throw new Error("Mismatch");
    } catch (e) {
        throw new Error("File missing or bad: " + e.message);
    }
}`);
        
        const wcmd = new t.testsys.Command(t.WORKER_BIN, { args: ["--module", "write.js"], cwd: tmpApi, stdout: "null", stderr: "inherit" });
        const wout = await wcmd.output();
        if (wout.code !== 0) throw new Error("Write failed");

        const rcmd = new t.testsys.Command(t.WORKER_BIN, { args: ["--module", "read.js"], cwd: tmpApi, stdout: "null", stderr: "inherit" });
        const rout = await rcmd.output();
        if (rout.code !== 0) throw new Error("Read failed - OPFS did not persist");

        // Verify audit logger
        const opfsId = btoa(tmpApi).replace(/[\/+=]/g, "");
        const auditLogPath = join(t.testsys.env.get("HOME") || "/tmp", ".webrun", "opfs", "path", opfsId, "audit.ndjson");
        const auditText = t.testsys.readTextFileSync(auditLogPath).trim().split("\n");
        if (auditText.length < 2) throw new Error("Expected at least 2 audit log entries (1 for write.js, 1 for read.js)");
        const lastAudit = JSON.parse(auditText[auditText.length - 1]);
        if (!lastAudit.timestamp || !lastAudit.args || !lastAudit.configPath) throw new Error("Malformed audit log entry");
    });

    await t.run("makeTempDir isolation: multiple calls yield independent directories", async () => {
        const tmpApi = t.testsys.realPathSync(t.testsys.makeTempDirSync());
        t.testsys.writeTextFileSync(`${tmpApi}/webrun.json`, "{}");
        t.testsys.writeTextFileSync(`${tmpApi}/multi.js`, `
import { makeTempDir } from "webrun/ctx";
export default async function() {
    const a = await makeTempDir();
    const b = await makeTempDir();

    // They must be different handles
    if (a.name === b.name) throw new Error("Handles share the same name");

    // Write to A, verify B does not see it
    const fh = await a.getFileHandle("only_in_a.txt", { create: true });
    const w = await fh.createWritable();
    await w.write("A_ONLY");
    await w.close();

    try {
        await b.getFileHandle("only_in_a.txt");
        throw new Error("B should not contain A's file");
    } catch (e) {
        if (!e.message.includes("could not be found")) throw e;
    }

    // Subdirectory support
    const sub = await a.getDirectoryHandle("nested", { create: true });
    const sf = await sub.getFileHandle("deep.txt", { create: true });
    const sw = await sf.createWritable();
    await sw.write("DEEP");
    await sw.close();
    const rd = await sub.getFileHandle("deep.txt");
    const file = await rd.getFile();
    if (await file.text() !== "DEEP") throw new Error("Subdirectory read failed");

    console.log("MULTI_OK");
}`);

        const cmd = new t.testsys.Command(t.WORKER_BIN, { args: ["--module", "multi.js"], cwd: tmpApi, stdout: "piped", stderr: "piped" });
        const out = await cmd.output();
        const stdout = new TextDecoder().decode(out.stdout);
        if (out.code !== 0 || !stdout.includes("MULTI_OK")) {
            const stderr = new TextDecoder().decode(out.stderr);
            throw new Error("makeTempDir isolation test failed\\nSTDOUT: " + stdout + "\\nSTDERR: " + stderr);
        }
    });

    await t.run("Ephemeral OPFS baseline: no persistence across runs", async () => {
        const tmpApi = t.testsys.realPathSync(t.testsys.makeTempDirSync());
        t.testsys.writeTextFileSync(`${tmpApi}/webrun.json`, "{}");
        t.testsys.writeTextFileSync(`${tmpApi}/write.js`, `
export default async function() {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle("ephemeral.txt", { create: true });
    const writable = await handle.createWritable();
    await writable.write("SHOULD_NOT_PERSIST");
    await writable.close();
}`);
        t.testsys.writeTextFileSync(`${tmpApi}/read.js`, `
export default async function() {
    const dir = await navigator.storage.getDirectory();
    try {
        await dir.getFileHandle("ephemeral.txt");
        throw new Error("LEAKED: ephemeral OPFS file persisted across runs");
    } catch (e) {
        if (e.message.includes("LEAKED")) throw e;
        // Expected: NotFoundError => ephemeral cleanup worked
    }
}`);

        const wcmd = new t.testsys.Command(t.WORKER_BIN, { args: ["--module", "write.js"], cwd: tmpApi, stdout: "null", stderr: "inherit" });
        const wout = await wcmd.output();
        if (wout.code !== 0) throw new Error("Ephemeral write failed");

        const rcmd = new t.testsys.Command(t.WORKER_BIN, { args: ["--module", "read.js"], cwd: tmpApi, stdout: "null", stderr: "piped" });
        const rout = await rcmd.output();
        if (rout.code !== 0) {
            const stderr = new TextDecoder().decode(rout.stderr);
            if (stderr.includes("LEAKED")) throw new Error("Ephemeral OPFS data leaked across runs");
            throw new Error("Ephemeral read check failed: " + stderr);
        }
    });

    await t.run("upgradeWebSocket throws clear error in non-serve mode", async () => {
        const tmpApi = t.testsys.realPathSync(t.testsys.makeTempDirSync());
        t.testsys.writeTextFileSync(`${tmpApi}/webrun.json`, "{}");
        t.testsys.writeTextFileSync(`${tmpApi}/ws_error.js`, `
import { upgradeWebSocket } from "webrun/ctx";
export default async function() {
    try {
        upgradeWebSocket(new Request("http://localhost/ws"));
        throw new Error("SHOULD_HAVE_THROWN");
    } catch (e) {
        if (e.message.includes("only available in --serve mode")) {
            console.log("GATE_OK");
        } else {
            throw e;
        }
    }
}`);
        const cmd = new t.testsys.Command(t.WORKER_BIN, { args: ["--module", "ws_error.js"], cwd: tmpApi, stdout: "piped", stderr: "piped" });
        const out = await cmd.output();
        const stdout = new TextDecoder().decode(out.stdout);
        if (out.code !== 0 || !stdout.includes("GATE_OK")) {
            const stderr = new TextDecoder().decode(out.stderr);
            throw new Error("upgradeWebSocket gate test failed\\nSTDOUT: " + stdout + "\\nSTDERR: " + stderr);
        }
    });
}
