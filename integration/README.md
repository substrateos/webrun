# Webrun Tests

Six categories, each with a dedicated orchestrator in `tests/`.

## Test Categories

| Suite | Directory | Orchestrator | Purpose |
|-------|-----------|-------------|---------|
| **SandboxCases** | `tests/sandbox/` | `sandbox.test.ts` | Single-boundary policy tests with auto-inversion |
| **Globals** | `tests/globals/` | `globals.test.ts` | Runtime-gated dual-pass tests (webrun vs raw Deno) |
| **Policy** | `tests/policy/` | `policy.test.ts` | Hierarchical privilege narrowing enforcement |
| **Api** | `tests/api/` | `api.test.ts` | W3C API correctness (OPFS, Workers, WebRTC) |
| **Bindings** | `tests/bindings/` | `bindings.test.ts` | Service binding IPC, SSRF protection, lifecycle |
| **Cli** | `tests/cli/` | `cli.test.ts` | CLI flag resolution, config discovery, help/version |

Plus `BundlingBehavior` and `Serve` suites. All registered in `webrun.test.ts`.

Run all: `make test`
Run one suite: `make test TEST_ARG=SandboxCases`

---

## Case Format

Each case is a standalone folder containing:
1. `cases.json` — Test definition and expected outcome.
2. `webrun.json` — Sandbox configuration (for sandbox/globals/policy tests).
3. Source files — The test payload (typically `src/*.js` or `main.ts`).

```json
[
  {
    "name": "Description of the test",
    "args": ["--module", "main.ts"],
    "env": { "SECRET": "value" },
    "cwd": "child",
    "expect": {
      "exit_code": 1,
      "stdout": [{"contains": "a string"}],
      "stderr": [{"contains": "another string"}],
      "files": [
        { "path": "out/result.txt", "contains": "success" },
        { "path": "secrets.txt", "exists": false }
      ]
    }
  }
]
```

Only `name` and `expect.exit_code` are required. `args` defaults to `["--module", "main.ts"]`. File paths in `expect.files` are relative to the case directory.

### Signal Mode (Long-Running Processes)

Cases targeting `--serve` or other long-running processes use a signal lifecycle:

```json
[
  {
    "name": "Static file serve",
    "args": ["--serve", "."],
    "cwd": "site",
    "signal": "SIGTERM",
    "timeout_ms": 5000,
    "expect": {
      "exit_code": 143,
      "ready": {
        "stdout": [{"contains": "Webrun serving at"}]
      },
      "http": [
        {
          "method": "GET",
          "path": "/index.html",
          "status": 200,
          "headers": {"content-type": "text/html"},
          "body": [{"contains": "<p>hello</p>"}]
        }
      ]
    }
  }
]
```

When `signal` is present, the orchestrator:
1. Starts the process and streams stdout/stderr.
2. Waits for `ready` assertions to match (gates the next phase).
3. Parses the listen port from the banner and executes `http` probes.
4. Sends `signal` to trigger shutdown.
5. Asserts `exit_code` after the process exits.

`timeout_ms` is the safety deadline — if `ready` assertions never match, the test fails. Batch-mode cases without `signal` use a default 30s safety timeout.

---

## Sandbox Tests (`tests/sandbox/`)

**Permission boundary tests.** Each test restricts specific permission axes in its `webrun.json` and verifies that the sandbox correctly enforces those restrictions.

### Declarative Negation

For sandbox tests that should fail due to a permission restriction, the test case declares an explicit `negation` block in `cases.json`. This block specifies the config overrides that would make the test pass:

```json
[
  {
    "name": "Blocks writes conditionally via read access map limits",
    "args": ["src/write_under_read.js"],
    "expect": {
      "exit_code": 1,
      "stderr": [{"contains": "BLOCKED:"}],
      "negation": {
        "permissions": {
          "storage": {
            ".": { "access": "read" },
            "data": { "access": "write" }
          }
        }
      }
    }
  }
]
```

When `negation` is present, the orchestrator automatically:
1. Copies the test to a temp directory.
2. Shallow-merges `negation.permissions` and `negation.limits` into the `webrun.json` config (each key fully replaces the original).
3. Inverts the expectations (exit 0 ↔ nonzero, `contains` ↔ `absent`).
4. Re-runs the same payload, verifying that relaxing the restriction makes the test pass.

This proves that the sandbox boundary — not a broken payload — is the sole cause of failure.

---

## Globals Tests (`tests/globals/`)

**Runtime-gated dual-pass tests.** Each test runs twice:
1. **WebRun pass** — through `./webrun`, expecting restricted behavior (Deno globals scrubbed, node:fs sinkholes, etc.)
2. **Raw Deno pass** — through `deno run -A`, expecting native behavior.

Uses a `cases.json` with `expect_webrun` and `expect_deno` instead of a single `expect`:

```json
[
  {
    "name": "Non-web globals are scrubbed from the sandbox",
    "args": ["--module", "main.ts"],
    "expect_webrun": { "exit_code": 0, "stdout": [{"contains": "CLEAN"}] },
    "expect_deno":   { "exit_code": 0, "stdout": [{"contains": "LEAKED"}] }
  }
]
```

---

## API Tests (`tests/api/`)

Standard correctness checks for W3C APIs (OPFS, fetch, Workers, etc.). These run inside the sandbox using Webrun's built-in test adapter.

```bash
./webrun --test tests/api/opfs.ts
```

Export named `test...` functions. Webrun discovers and injects `t` (test adapter) and `ctx` (sandbox context):

```typescript
export async function testOPFSCreateFile(t: any, ctx: any) {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle("demo.txt", { create: true });
    t.assert(handle.name === "demo.txt", "File handle name should match");
}
```

If a test needs to crash or kill the process, it belongs in `tests/sandbox/` or `tests/globals/`.
