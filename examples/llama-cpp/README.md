# WebRun llama.cpp Example

This example demonstrates how WebRun scripts can launch native binaries inside the OS-level sandbox using `ctx.run()`. Here, `llama-server` runs directly as a child process — WebRun's binary mode execs it after applying the seatbelt/landlock jail.

## How the Port Works

The parent passes `--serve` to `ctx.run`, which allocates an ephemeral port and injects it into the binary's environment. The `portEnv` field in `webrun.json` configures which environment variable receives the port (defaults to `PORT`; this example uses `LLAMA_ARG_PORT`). The parent discovers the same port via `handle.urls`.

## Prerequisites

You need `llama-server` available in your system `$PATH`. The fastest way is to download the latest pre-compiled release from the [official GitHub Releases page](https://github.com/ggml-org/llama.cpp/releases), unzip it, and add the directory to your `$PATH`.

## Running the Example

```bash
webrun examples/llama-cpp/main.ts
```

The script will:
1. Resolve a persistent OPFS cache directory for model weights and certificates.
2. Download Mozilla CA certificates on first run (cached in OPFS for subsequent runs).
3. Launch `llama-server` as a sandboxed child process with GPU acceleration.
4. Stream formatted server stderr logs to the terminal.
5. Automatically download and cache a 1.1B parameter model (TinyLlama). The first run may take a minute for the download.
6. Poll the server health endpoint until ready (with fail-fast on server crash).
7. Send a chat completion request and print the response.

## Caching

Model weights and CA certificates are cached persistently in OPFS (configured via `@webrun/opfs` with `"origin": "path"`). To clear the cache, delete the OPFS directory at `~/.webrun/opfs/path/<id>/fs/`.

## webrun.json

The `webrun.json` config declares:
- `"binaries": [["llama-server"]]` — permit execution of the llama-server binary
- `"network": ["*"]` — allow HTTP requests (model download and server health checks)
- `"run": true` — enable `ctx.run()`
- `"gpu": true` — enable GPU hardware acceleration (Metal/Vulkan)
- `"env": [...]` — allowlist of environment variables for HuggingFace cache and SSL configuration
- `"@webrun/opfs": { "origin": "path" }` — persistent OPFS storage for model caching
