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

**Single-boundary policy tests.** Each test restricts exactly ONE permission axis in its `webrun.json`, with all other axes maximally permissive. The test payload is designed to fail only because of that one restriction.

### Auto-Inversion

For each failing sandbox test, the orchestrator automatically:
1. Detects which permission axis is restricted.
2. Copies the test to a temp directory.
3. Rewrites `webrun.json` to relax the restricted axis.
4. Re-runs the same payload, expecting exit 0.

This proves that the sandbox boundary — not a broken payload — is the sole cause of failure.

### Single-Boundary Invariant

Each `webrun.json` must be maximally permissive except for ONE axis:

| Axis | Permissive Value | Restricted Example |
|------|------------------|--------------------|
| `storage` | `{".": {"access": "read"}, "data": {"access": "write"}}` | absent, or `{".": {"access": "read"}}` without write subdirs |
| `network` | `["*"]` (wildcard = allow all) | absent or `[]` |
| `env` | `["*"]` (wildcard = inject all host vars) | absent or `[]` |
| `limits.timeoutMillis` | `300000` or absent | any lower value |
| `limits.memoryMB` | `4096` or absent | any lower value |

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
