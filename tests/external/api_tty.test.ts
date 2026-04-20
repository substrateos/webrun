// api_tty.test.ts — TTY lifecycle, cleanup, and raw mode tests.
//
// Requires: real TTY (stdin: "inherit"), stty.
// Runner: ~/.cache/webrun/deno/deno-*/deno test -A tests/external/api_tty.test.ts

import { denoTest } from "./_adapter.ts";
import { join, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

denoTest("ApiTty", async (t) => {
    const WORKER_BIN = Deno.env.get("WEBRUN_BIN") || join(dirname(new URL(import.meta.url).pathname), "../../webrun");

    await t.run("ctx.tty lifecycle: setRawMode, isRaw, columns, rows", async () => {
        const tmpApi = Deno.realPathSync(Deno.makeTempDirSync());
        Deno.writeTextFileSync(`${tmpApi}/webrun.json`, "{}");
        Deno.writeTextFileSync(`${tmpApi}/tty_lifecycle.js`, `
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
        const proc = new Deno.Command(WORKER_BIN, {
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
        const tmpApi = Deno.realPathSync(Deno.makeTempDirSync());
        Deno.writeTextFileSync(`${tmpApi}/webrun.json`, "{}");
        Deno.writeTextFileSync(`${tmpApi}/tty_cleanup.js`, `
export default async function(ctx) {
    if (!ctx.tty) { console.log("NO_TTY"); return; }
    await ctx.tty.setRawMode(true);
    console.log("RAW_ENABLED");
    throw new Error("DELIBERATE_CRASH");
}`);
        const proc = new Deno.Command(WORKER_BIN, {
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
        if (!stdout.includes("RAW_ENABLED")) {
            throw new Error("TTY cleanup test failed: raw mode was never enabled\nSTDOUT: " + stdout + "\nSTDERR: " + stderr);
        }
        if (!stderr.includes("DELIBERATE_CRASH")) {
            throw new Error("TTY cleanup test failed: expected deliberate crash error\nSTDOUT: " + stdout + "\nSTDERR: " + stderr);
        }
        if (out.code === 0) {
            throw new Error("TTY cleanup test failed: expected non-zero exit code");
        }
    });

    await t.run("ctx.tty cleanup: raw mode restored after timeout", async () => {
        const tmpApi = Deno.realPathSync(Deno.makeTempDirSync());
        Deno.writeTextFileSync(`${tmpApi}/webrun.json`, JSON.stringify({
            limits: { timeoutMillis: 2000 }
        }));
        Deno.writeTextFileSync(`${tmpApi}/tty_timeout.js`, `
export default async function(ctx) {
    if (!ctx.tty) { console.log("NO_TTY"); return; }
    await ctx.tty.setRawMode(true);
    console.log("RAW_ENABLED");
    while(true) {}
}`);
        let initialStty = "";
        try {
            const sttyCmd = new Deno.Command("stty", { args: ["-g"], stdout: "piped", stdin: "inherit" });
            const sttyOut = await sttyCmd.output();
            initialStty = new TextDecoder().decode(sttyOut.stdout).trim();
        } catch (_) {
            return t.log("Skipping: no stty available");
        }

        const proc = new Deno.Command(WORKER_BIN, {
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
            const sttyCmd = new Deno.Command("stty", { args: ["-g"], stdout: "piped", stdin: "inherit" });
            const sttyOut = await sttyCmd.output();
            finalStty = new TextDecoder().decode(sttyOut.stdout).trim();
        } catch (_) {}

        if (!stdout.includes("RAW_ENABLED")) {
            throw new Error("TTY timeout test failed: raw mode was never enabled\nSTDOUT: " + stdout + "\nSTDERR: " + stderr);
        }
        if (!stderr.includes("Timeout limit reached")) {
            throw new Error("TTY timeout test failed: expected timeout error\nSTDOUT: " + stdout + "\nSTDERR: " + stderr);
        }
        if (out.code !== 143) {
            throw new Error("TTY timeout test failed: expected exit code 143, got " + out.code);
        }

        if (initialStty !== finalStty) {
            try {
                const restoreCmd = new Deno.Command("stty", { args: [initialStty] });
                await restoreCmd.output();
            } catch (_) {}
            throw new Error("TTY timeout test failed: terminal state was modified and not restored.");
        }
    });

    await t.run("ctx.tty raw mode protects stdin reads from EAGAIN", async () => {
        const tmpApi = Deno.realPathSync(Deno.makeTempDirSync());
        Deno.writeTextFileSync(`${tmpApi}/webrun.json`, "{}");
        Deno.writeTextFileSync(`${tmpApi}/tty_eagain.js`, `
export default async function(ctx) {
    if (!ctx.tty || !ctx.stdin) { console.log("NO_TTY"); return; }
    await ctx.tty.setRawMode(true);
    try {
        const reader = ctx.stdin.getReader();
        const v = await Promise.race([
            reader.read().catch(e => { throw new Error("READ_THREW: " + e.message); }),
            new Promise(r => setTimeout(() => r("HANG_SUCCESS"), 50))
        ]);
        console.log(v);
    } finally {
        await ctx.tty.setRawMode(false);
    }
}`);
        const proc = new Deno.Command(WORKER_BIN, {
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
            throw new Error("TTY EAGAIN test failed.\nSTDOUT: " + stdout + "\nSTDERR: " + stderr);
        }
    });
});
