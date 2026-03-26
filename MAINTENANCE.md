# Maintenance and Contribution

This guide explains `webrun` repository structure, dependency management, testing, and bundling.

## Repository Organization

`webrun` is a self-bundling Bash script that wraps an isolated JavaScript/TypeScript runtime engine.

```text
.
├── webrun                 # Self-bootstrapping executable wrapper
├── webrun.ts              # Main entrypoint
├── webrun.test.ts         # Built-in test suite
├── src/                   # Implementation
│   ├── config.ts          # Policy parsing and environment configuration
│   ├── execution.ts       # Sandbox lifecycle and security orchestration
│   ├── fs.ts              # Virtualized filesystem (OPFS) abstractions
│   ├── sys.ts             # Host OS and platform interop layer
│   └── types.ts           # Shared domain models and interfaces
├── test/                  # Test suite
├── deno.json              # Enables dependency vendoring ("vendor": true) and import maps
├── deno.lock              # Ensures cryptographically tied dependency resolution
└── vendor/                # Local cache of remote modules. Allows complete offline execution
```

## Updating Dependencies

Changes must sync with the `vendor/` cache.

1. **Update Imports:** Modify the respective version URLs inside the `"imports"` object in `deno.json`.
2. **Refresh Vendor Cache:**
   ```bash
   ./webrun --self-vendor
   ```
3. **Commit:** Stage modified TypeScript files, `deno.lock`, and `vendor/`.

## Testing

1. **Run Tests:**
   ```bash
   ./webrun --self-test
   ```
   *Run specific tests: `./webrun --self-test "SandboxIsolationLimits"`*

2. **Verify Offline Isolation:** Ensure changes do not require network access during isolated runs.

## Bundling Distributions

`webrun` is distributed as a single script containing runtime logic and vendored dependencies.

1. **Generate the Bundle:**
   ```bash
   ./webrun --self-bundle > webrun-dist
   chmod +x webrun-dist
   ```

2. **Verify Extraction:**
   ```bash
   ./webrun-dist --self-unbundle webrun-src-extracted
   ```
