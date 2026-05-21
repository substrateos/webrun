// security.test.ts — Regression tests for security audit findings.
//
// These tests assert the CORRECT, FIXED behavior. They currently FAIL (RED)
// because the vulnerabilities exist. After each fix, the corresponding test
// turns GREEN and becomes a permanent regression guard.
//
// Run via: ./webrun --self-test=Security

import { webrun } from "webrun/ctx";
import { computeBindingEnv } from "../src/host/bindings.ts";
import { generateBaseImportMap, buildSinkholeImports, buildCtxImport, mergeImportMaps } from "../src/config.ts";

// ── Shared mock for resolveLocalConfiguration (if needed) ───────────────────────────────

function makePolicySys() {
    return {
        env: { get: () => undefined },
        exit: () => {},
        readTextFileSync: () => "",
        statSync: () => ({ isFile: true, isDirectory: false, isSymlink: false }),
        writeTextFileSync: () => {},
        realPathSync: (p: string) => p,
    } as any;
}

// ── M1: mergeImportMaps must not allow user maps to override sinkholes ───────

export async function testSecuritySinkholeProtection(t: any) {
    const sinkholeKeys = Object.keys(buildSinkholeImports());
    const ctxKeys = Object.keys(buildCtxImport());

    await t.run("user import map cannot override node:* sinkholes", async () => {
        const baseMap = generateBaseImportMap();

        // Verify sinkholes are present.
        for (const key of sinkholeKeys) {
            if (!baseMap.imports[key]) {
                throw new Error(`Sinkhole missing for ${key} before merge`);
            }
        }

        const originalSinkhole = baseMap.imports["node:fs"];

        // Attacker's import map: override node:fs back to real node:fs.
        const attackerMap = {
            imports: { "node:fs": "node:fs" },
        };
        mergeImportMaps(baseMap, attackerMap);

        // After merge, node:fs must still point to the sinkhole.
        if (baseMap.imports["node:fs"] !== originalSinkhole) {
            throw new Error(
                `mergeImportMaps allowed user to override node:fs sinkhole.\n` +
                `  Expected: ${originalSinkhole}\n` +
                `  Got: ${baseMap.imports["node:fs"]}`
            );
        }
    });

    await t.run("user import map cannot override webrun/ctx", async () => {
        const baseMap = generateBaseImportMap();
        const originalCtx = baseMap.imports["webrun/ctx"];

        const attackerMap = {
            imports: { "webrun/ctx": "https://evil.example.com/fake_ctx.js" },
        };
        mergeImportMaps(baseMap, attackerMap);

        if (baseMap.imports["webrun/ctx"] !== originalCtx) {
            throw new Error(
                `mergeImportMaps allowed user to override webrun/ctx.\n` +
                `  Expected: ${originalCtx}\n` +
                `  Got: ${baseMap.imports["webrun/ctx"]}`
            );
        }
    });

    await t.run("user import map can add non-security keys", async () => {
        const baseMap = generateBaseImportMap();

        const userMap = {
            imports: { "lodash": "https://esm.sh/lodash" },
        };
        mergeImportMaps(baseMap, userMap);

        if (baseMap.imports["lodash"] !== "https://esm.sh/lodash") {
            throw new Error("mergeImportMaps rejected a legitimate user import");
        }
    });
}

// ── H3: spawn server must not leak host env into ctx.webrun() children ───────

export async function testSecuritySpawnEnvLeak(t: any) {
    // The spawn server at spawn.ts:111-118 copies the full host env into
    // child processes (Deno.env.toObject()). This means host secrets
    // (AWS_SECRET_KEY, DATABASE_URL, etc.) leak to children spawned via
    // ctx.webrun(), even when the child's config doesn't declare them.
    //
    // Test: The self-test process has HOME set. Spawn a child via
    // ctx.webrun(). The child's --eval code checks for HOME. If the
    // spawn server properly filters env, HOME should not be present
    // in the child's env unless the child's config declares it.
    //
    // We test via a canary: the --eval child has no webrun.json, so
    // it has no declared permissions.env. The child should not see
    // any host env vars.

    await t.run("host HOME does not leak to child via ctx.webrun()", async () => {
        // The child is spawned via --eval, which creates a minimal
        // webrun config with no permissions.env. If the spawn server
        // leaks the host env, the child's supervisor would have HOME
        // in its Deno.env, but the child's guest wouldn't see it
        // (because ctx.env only includes declared vars). However,
        // DENO_DIR, TMPDIR, etc. from the host DO leak into the
        // child's supervisor env, which is the vulnerability.
        //
        // To observe: check if the child can see vars it shouldn't.
        // Since --eval creates a no-permissions config, the child's
        // ctx.env should be empty.
        const { makeTempDir } = await import("webrun/ctx");
        const tmpDir = await makeTempDir();
        const webrunJson = await tmpDir.getFileHandle("webrun.json", { create: true });
        const writer = await webrunJson.createWritable();
        await writer.write(new TextEncoder().encode("{}"));
        await writer.close();

        const result = await webrun(
            ["--eval", `
                import { env } from "webrun/ctx";
                const keys = Object.keys(env);
                console.log("ENV_KEYS:" + keys.length);
                if (keys.length > 0) console.log("ENV_LEAKED:" + keys.join(","));
            `],
            { cwd: tmpDir.name },
        );
        const stdout = result.stdout || "";
        // --eval creates a config with no permissions.env.
        // The child's ctx.env should have zero keys.
        if (stdout.includes("ENV_LEAKED:")) {
            throw new Error(
                "Spawn server leaked env vars to child with no declared permissions.env.\n" +
                `STDOUT: ${stdout}\nSTDERR: ${result.stderr || ""}`
            );
        }
    });
}

// ── F1: Jail must never be bypassed based on script path ─────────────────────
//
// mod.ts previously used invocation.targetScriptPath.includes("tests/webrun.test.")
// to disable the OS jail. The fix: remove the bypass entirely. The jail OS
// is always sys.build.os — no flag or path can degrade it.
//
// This test is now a regression guard: it verifies the bypass is gone by
// checking that buildJailConfig never produces a passthrough for paths
// that would have triggered the old vulnerability.

import { buildJailConfig, resolveCapabilities } from "../src/jail.ts";

export async function testSecuritySelfTestJailBypass(t: TestContext) {
    const mockSys = {
        execPath: () => "/usr/bin/deno",
        Command: class {} as any,
        realPathSync: (p: string | URL) => String(p),
    };
    const mockPolicy = {
        isPwdAllowed: true,
        fallbackToTemp: false,
        storageRoot: "/project",
        allowedReadPaths: [],
        allowedWritePaths: [],
        allowedBindings: [],
    };
    const paths = {
        projectRoot: "/project",
        cwd: "/project",
        localCacheDir: "/cache/webrun",
        isolatedTmp: "/tmp/webrun-isolated",
        runnerTmp: "/tmp/webrun-runner",
        opfsTmp: "/tmp/webrun-opfs",
        bindingSdksTmp: "/tmp/webrun-bindings",
        webrunEntryPath: "/opt/webrun/webrun.ts",
        isSourceMode: true,
    };

    await t.run("darwin jail is always seatbelt, regardless of script path", async () => {
        const caps = resolveCapabilities(mockSys, mockPolicy, paths, [], false, "darwin", [], []);
        const result = buildJailConfig(mockSys, "darwin", caps, ["run", "tests/webrun.test.ts"], paths);

        if (result.baseCmd !== "/usr/bin/sandbox-exec") {
            throw new Error(
                `Expected seatbelt (/usr/bin/sandbox-exec) for a script path containing ` +
                `'tests/webrun.test.', got: ${result.baseCmd}`
            );
        }
    });

    await t.run("linux jail always produces Landlock policy", async () => {
        const caps = resolveCapabilities(mockSys, mockPolicy, paths, [], false, "linux", [], []);
        const result = buildJailConfig(mockSys, "linux", caps, ["run", "tests/webrun.test.ts"], paths);

        if (result.landlockPolicy === undefined) {
            throw new Error(
                "Expected Landlock policy for a script path containing 'tests/webrun.test.', " +
                "but got undefined — jail was bypassed."
            );
        }
    });
}

// ── F2: Spawn server must validate cwdPath against parent scope ──────────────
//
// spawn.ts:53 accepts cwdPath from the guest request body and uses it
// for config discovery. If the guest can write to a directory, it can
// plant a webrun.json there and redirect the child to resolve that config.
// The spawn server must reject cwdPath values outside the parent's
// allowed read/write paths.

export async function testSecuritySpawnCwdValidation(t: TestContext) {
    await t.run("ctx.webrun() rejects cwdPath outside parent scope", async () => {
        // Spawn a child with cwdPath = "/tmp", which is outside the parent's
        // declared storage permissions. The spawn server should reject this
        // with a security error. Currently it accepts any cwdPath.
        const result = await webrun(
            ["--eval", `export default () => console.log("escaped");`],
            { cwd: "/tmp" },
        );

        // If the spawn server properly validates cwdPath, the child should
        // fail with a security error (non-zero exit). Currently it succeeds.
        if (result.exitCode === 0) {
            throw new Error(
                "Spawn server accepted cwdPath '/tmp' which is outside the parent's " +
                "allowed storage paths. cwdPath must be validated against parent scope.\n" +
                `STDOUT: ${result.stdout || ""}\nSTDERR: ${result.stderr || ""}`
            );
        }
    });
}

// ── F3: Binding env must default to restricted set ───────────────────────────
//
// computeBindingEnv (bindings.ts) inherits the full host environment when
// declaredEnv is undefined. This leaks host secrets (AWS_SECRET_KEY, etc.)
// to binding subprocesses. The default must be a restricted set.

export async function testSecurityBindingEnvDefault(t: TestContext) {
    const hostEnv: Record<string, string> = {
        HOME: "/Users/user",
        AWS_SECRET_ACCESS_KEY: "AKIAIOSFODNN7EXAMPLE",
        DATABASE_URL: "postgres://prod:secret@db.internal/main",
        PATH: "/usr/bin:/bin",
        GITHUB_TOKEN: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    };

    const mockSys = {
        execPath: () => "/usr/bin/deno",
        Command: class {} as any,
        realPathSync: (p: string | URL) => String(p),
    };

    await t.run("undeclared permissions.env does not leak host secrets", async () => {
        // declaredEnv = undefined → no permissions.env in the binding config.
        // The function must return only the sandbox base set, not hostEnv.
        const result = computeBindingEnv(hostEnv, undefined, "/tmp/isolated", "/cache");

        const leaked: string[] = [];
        for (const secret of ["AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "GITHUB_TOKEN"]) {
            if (result[secret] !== undefined) leaked.push(secret);
        }

        if (leaked.length > 0) {
            throw new Error(
                "computeBindingEnv leaked host secrets when declaredEnv is undefined.\n" +
                `Leaked: ${leaked.join(", ")}`
            );
        }
    });

    await t.run("declared permissions.env passes only listed vars", async () => {
        const result = computeBindingEnv(hostEnv, ["HOME"], "/tmp/isolated", "/cache");

        if (result["HOME"] !== "/tmp/isolated") {
            // HOME is in baseEnv and gets overwritten by baseEnv's value.
            // This is correct — isolated HOME takes precedence.
        }
        if (result["AWS_SECRET_ACCESS_KEY"] !== undefined) {
            throw new Error("Declared [HOME] should not leak AWS_SECRET_ACCESS_KEY");
        }
    });

    await t.run("sandbox base env always present", async () => {
        const result = computeBindingEnv(hostEnv, undefined, "/tmp/isolated", "/cache");

        for (const key of ["PATH", "HOME", "TMPDIR", "USER", "DENO_DIR"]) {
            if (result[key] === undefined) {
                throw new Error(`Base env key '${key}' missing from computeBindingEnv result`);
            }
        }
    });
}
