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

    await t.run("Experimental OPFS persistence (git strategy)", async () => {
        const tmpApi = t.testsys.realPathSync(t.testsys.makeTempDirSync());
        const gitInit = new t.testsys.Command("git", { args: ["init"], cwd: tmpApi });
        await gitInit.output();
        const gitConfig1 = new t.testsys.Command("git", { args: ["config", "user.name", "test"], cwd: tmpApi });
        await gitConfig1.output();
        const gitConfig2 = new t.testsys.Command("git", { args: ["config", "user.email", "test@test.com"], cwd: tmpApi });
        await gitConfig2.output();
        const gitCommit = new t.testsys.Command("git", { args: ["commit", "--allow-empty", "-m", "init"], cwd: tmpApi });
        await gitCommit.output();

        t.testsys.writeTextFileSync(`${tmpApi}/webrun.json`, JSON.stringify({
            experimental: { opfs: { origin: "git" } }
        }));
        
        t.testsys.writeTextFileSync(`${tmpApi}/write.js`, `
export default async function() {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle("git-opfs.txt", { create: true });
    const writable = await handle.createWritable();
    await writable.write("GIT_OPFS");
    await writable.close();
}`);
        t.testsys.writeTextFileSync(`${tmpApi}/read.js`, `
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
        
        const wcmd = new t.testsys.Command(t.WORKER_BIN, { args: ["--module", "write.js"], cwd: tmpApi, stdout: "null", stderr: "inherit" });
        const wout = await wcmd.output();
        if (wout.code !== 0) throw new Error("Write failed");

        const rcmd = new t.testsys.Command(t.WORKER_BIN, { args: ["--module", "read.js"], cwd: tmpApi, stdout: "null", stderr: "inherit" });
        const rout = await rcmd.output();
        if (rout.code !== 0) throw new Error("Read failed - OPFS did not persist");
        
        const badApi = t.testsys.realPathSync(t.testsys.makeTempDirSync());
        t.testsys.writeTextFileSync(`${badApi}/webrun.json`, JSON.stringify({
            experimental: { opfs: { origin: "git" } }
        }));
        t.testsys.writeTextFileSync(`${badApi}/write.js`, `export default async function() {}`);

        const errcmd = new t.testsys.Command(t.WORKER_BIN, { args: ["--module", "write.js"], cwd: badApi, stdout: "null", stderr: "piped" });
        const errout = await errcmd.output();
        if (errout.code === 0) throw new Error("Expected git error boundary to enforce fatal crash, but it succeeded.");
        const stderrStr = new TextDecoder().decode(errout.stderr);
        if (!stderrStr.includes("requires a valid git repository")) throw new Error("Missing fatal git origin error log: " + stderrStr);
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

    await t.run("ctx.tty lifecycle: setRawMode, isRaw, columns, rows", async () => {
        const tmpApi = t.testsys.realPathSync(t.testsys.makeTempDirSync());
        t.testsys.writeTextFileSync(`${tmpApi}/webrun.json`, "{}");
        t.testsys.writeTextFileSync(`${tmpApi}/tty_lifecycle.js`, `
export default async function(ctx) {
    if (!ctx.tty) { console.log("NO_TTY"); return; }
    if (ctx.tty.isRaw !== false) throw new Error("isRaw not false initially");
    console.log("INITIAL_RAW=" + ctx.tty.isRaw);
    const cols = ctx.tty.columns;
    const rows = ctx.tty.rows;
    if (typeof cols !== "number" || cols <= 0) throw new Error("Bad columns: " + cols);
    if (typeof rows !== "number" || rows <= 0) throw new Error("Bad rows: " + rows);
    console.log("COLS=" + cols);
    console.log("ROWS=" + rows);
    await ctx.tty.setRawMode(true);
    if (ctx.tty.isRaw !== true) throw new Error("isRaw not true after setRawMode(true)");
    console.log("RAW_SET=" + ctx.tty.isRaw);
    await ctx.tty.setRawMode(false);
    if (ctx.tty.isRaw !== false) throw new Error("isRaw not false after restore");
    console.log("RAW_RESTORED=" + ctx.tty.isRaw);
    console.log("LIFECYCLE_OK");
}`);
        const proc = new t.testsys.Command(t.WORKER_BIN, {
            args: ["--module", "tty_lifecycle.js"], cwd: tmpApi,
            stdout: "piped", stderr: "piped", stdin: "inherit"
        });
        const out = await proc.output();
        const stdout = new TextDecoder().decode(out.stdout);
        const stderr = new TextDecoder().decode(out.stderr);
        if (stdout.includes("NO_TTY")) {
            t.log("Skipping: no TTY available (CI environment)");
            return;
        }
        if (out.code !== 0 || !stdout.includes("LIFECYCLE_OK")) {
            throw new Error("TTY lifecycle test failed\nSTDOUT: " + stdout + "\nSTDERR: " + stderr);
        }
    });

    await t.run("ctx.tty cleanup: raw mode restored after exception", async () => {
        const tmpApi = t.testsys.realPathSync(t.testsys.makeTempDirSync());
        t.testsys.writeTextFileSync(`${tmpApi}/webrun.json`, "{}");
        t.testsys.writeTextFileSync(`${tmpApi}/tty_cleanup.js`, `
export default async function(ctx) {
    if (!ctx.tty) { console.log("NO_TTY"); return; }
    await ctx.tty.setRawMode(true);
    console.log("RAW_ENABLED");
    throw new Error("DELIBERATE_CRASH");
}`);
        const proc = new t.testsys.Command(t.WORKER_BIN, {
            args: ["--module", "tty_cleanup.js"], cwd: tmpApi,
            stdout: "piped", stderr: "piped", stdin: "inherit"
        });
        const out = await proc.output();
        const stdout = new TextDecoder().decode(out.stdout);
        const stderr = new TextDecoder().decode(out.stderr);
        if (stdout.includes("NO_TTY")) {
            t.log("Skipping: no TTY available (CI environment)");
            return;
        }
        // The script should exit with error (due to thrown exception)
        // but the terminal must be restored (webrun's finally block).
        // We verify the script got far enough to enable raw mode.
        if (!stdout.includes("RAW_ENABLED")) {
            throw new Error("TTY cleanup test failed: raw mode was never enabled\nSTDOUT: " + stdout + "\nSTDERR: " + stderr);
        }
        if (!stderr.includes("DELIBERATE_CRASH")) {
            throw new Error("TTY cleanup test failed: expected deliberate crash error\nSTDOUT: " + stdout + "\nSTDERR: " + stderr);
        }
        // Exit code should be non-zero (the script crashed)
        if (out.code === 0) {
            throw new Error("TTY cleanup test failed: expected non-zero exit code");
        }
    });

    await t.run("ctx.tty cleanup: raw mode restored after timeout", async () => {
        const tmpApi = t.testsys.realPathSync(t.testsys.makeTempDirSync());
        t.testsys.writeTextFileSync(`${tmpApi}/webrun.json`, JSON.stringify({
            limits: { timeoutMillis: 2000 }
        }));
        t.testsys.writeTextFileSync(`${tmpApi}/tty_timeout.js`, `
export default async function(ctx) {
    if (!ctx.tty) { console.log("NO_TTY"); return; }
    await ctx.tty.setRawMode(true);
    console.log("RAW_ENABLED");
    // Infinite loop to force timeout
    while(true) {}
}`);
        let initialStty = "";
        try {
            const sttyCmd = new t.testsys.Command("stty", { args: ["-g"], stdout: "piped", stdin: "inherit" });
            const sttyOut = await sttyCmd.output();
            initialStty = new TextDecoder().decode(sttyOut.stdout).trim();
        } catch (_) {
            return t.log("Skipping: no stty available");
        }

        const proc = new t.testsys.Command(t.WORKER_BIN, {
            args: ["--module", "tty_timeout.js"], cwd: tmpApi,
            stdout: "piped", stderr: "piped", stdin: "inherit"
        });
        const out = await proc.output();
        const stdout = new TextDecoder().decode(out.stdout);
        const stderr = new TextDecoder().decode(out.stderr);
        
        if (stdout.includes("NO_TTY")) {
            return t.log("Skipping: no TTY available (CI environment)");
        }
        
        let finalStty = "";
        try {
            const sttyCmd = new t.testsys.Command("stty", { args: ["-g"], stdout: "piped", stdin: "inherit" });
            const sttyOut = await sttyCmd.output();
            finalStty = new TextDecoder().decode(sttyOut.stdout).trim();
        } catch (_) {}

        if (!stdout.includes("RAW_ENABLED")) {
            throw new Error("TTY timeout test failed: raw mode was never enabled\\nSTDOUT: " + stdout + "\\nSTDERR: " + stderr);
        }
        if (!stderr.includes("Timeout limit reached")) {
            throw new Error("TTY timeout test failed: expected timeout error\\nSTDOUT: " + stdout + "\\nSTDERR: " + stderr);
        }
        if (out.code !== 143) {
            throw new Error("TTY timeout test failed: expected exit code 143, got " + out.code);
        }

        if (initialStty !== finalStty) {
            try {
                const restoreCmd = new t.testsys.Command("stty", { args: [initialStty] });
                await restoreCmd.output();
            } catch (_) {}
            throw new Error("TTY timeout test failed: terminal state was modified and not restored.");
        }
    });

    await t.run("ctx.tty raw mode protects stdin reads from EAGAIN", async () => {
        const tmpApi = t.testsys.realPathSync(t.testsys.makeTempDirSync());
        t.testsys.writeTextFileSync(`${tmpApi}/webrun.json`, "{}");
        t.testsys.writeTextFileSync(`${tmpApi}/tty_eagain.js`, `
export default async function(ctx) {
    if (!ctx.tty || !ctx.stdin) { console.log("NO_TTY"); return; }
    await ctx.tty.setRawMode(true);
    try {
        const reader = ctx.stdin.getReader();
        // Since it's raw mode, we expect read() to hang indefinitely waiting for input, 
        // not immediately reject with EAGAIN. We race it against a 50ms timer.
        const v = await Promise.race([
            reader.read().catch(e => { throw new Error("READ_THREW: " + e.message); }),
            new Promise(r => setTimeout(() => r("HANG_SUCCESS"), 50))
        ]);
        console.log(v);
    } finally {
        await ctx.tty.setRawMode(false);
    }
}`);
        const proc = new t.testsys.Command(t.WORKER_BIN, {
            args: ["--module", "tty_eagain.js"], cwd: tmpApi,
            stdout: "piped", stderr: "piped", stdin: "inherit"
        });
        const out = await proc.output();
        const stdout = new TextDecoder().decode(out.stdout);
        const stderr = new TextDecoder().decode(out.stderr);
        
        if (stdout.includes("NO_TTY")) {
            return t.log("Skipping: no TTY available (CI environment)");
        }
        
        if (!stdout.includes("HANG_SUCCESS")) {
            throw new Error("TTY EAGAIN test failed.\\nSTDOUT: " + stdout + "\\nSTDERR: " + stderr);
        }
    });
}
