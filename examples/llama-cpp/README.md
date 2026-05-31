# WebRun llama.cpp Example

This example demonstrates how WebRun scripts can launch native binaries inside the OS-level sandbox using `ctx.run()`. Here, `llama-server` runs directly as a child process — WebRun's binary mode execs it after applying the seatbelt/landlock jail.

## How the Port Works

The parent passes `--serve` to `ctx.run`, which allocates an ephemeral port and injects it into the binary's environment as `PORT`. The parent discovers the same port via `handle.urls`. This is the standard convention (Heroku, Cloud Run, Fly.io).

`llama-server` reads `PORT` from its environment to know which port to bind.

## Prerequisites

You need `llama-server` available in your system `$PATH`. The fastest way is to download the latest pre-compiled release from the [official GitHub Releases page](https://github.com/ggml-org/llama.cpp/releases), unzip it, and add the directory to your `$PATH`.

## Running the Example

```bash
webrun examples/llama-cpp/main.ts
```

The script will:
1. Launch `llama-server` as a sandboxed child process via `ctx.run(["--serve", "llama-server", ...])`.
2. Automatically download and cache a 1.1B parameter model (TinyLlama). The first run may take a minute for the download.
3. Discover the allocated port via `handle.urls`.
4. Poll the server health endpoint until ready.
5. Send a chat completion request and print the response.

## webrun.json

The `webrun.json` config declares:
- `"binaries": [["llama-server"]]` — permit execution of the llama-server binary
- `"network": ["*"]` — allow HTTP requests to the child server
- `"run": true` — enable `ctx.run()`
