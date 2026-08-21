/**
 * WebRun Llama.cpp Example
 *
 * Demonstrates using ctx.run() to launch llama-server as a native binary
 * inside the OS-level sandbox. WebRun allocates an ephemeral serve port
 * and injects it as PORT into the binary's environment. The parent reads
 * handle.urls to discover the address.
 */

export default {
  async main(args, env, ctx) {
    console.log("[+] Resolving persistent OPFS cache...");
    const opfsDir = await navigator.storage.getDirectory();
    
    // Use ctx.run.arg to resolve the handle, and URL to cleanly extract the OS path
    const cacheUrl = ctx.run.arg`${opfsDir}`.value;
    const cachePath = new URL(cacheUrl).pathname;

    let caCertExists = false;
    try {
        const handle = await opfsDir.getFileHandle("cacert.pem");
        const file = await handle.getFile();
        caCertExists = file.size > 0;
    } catch {}

    if (!caCertExists) {
        console.log("[+] Downloading Mozilla CA certificates for llama-server...");
        const res = await fetch("https://curl.se/ca/cacert.pem");
        if (!res.ok) throw new Error("Failed to download cacert.pem");
        const text = await res.text();
        const fileHandle = await opfsDir.getFileHandle("cacert.pem", { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(text);
        await writable.close();
    }

    console.log(`[+] Launching llama-server (HF_HOME=${cachePath})...`);
    const envConfig = { 
        HF_HOME: cachePath,
        HF_HUB_CACHE: cachePath,
        LLAMA_CACHE: cachePath,
        HOME: ctx.env.HOME || "",
        SSL_CERT_FILE: cachePath + "/cacert.pem",
        SSL_CERT_DIR: ctx.env.SSL_CERT_DIR || "",
        NIX_SSL_CERT_FILE: ctx.env.NIX_SSL_CERT_FILE || ""
    };

    const handle = await ctx.run([
      "--serve",
      "llama-server",
      "--hf-repo", "TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF",
      "--hf-file", "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf",
      "--host", "127.0.0.1",
    ], {
      env: envConfig,
      storage: [{ handle: opfsDir, access: "write" }]
    });

    if (handle.stderr && ctx.stderr) {
      const decoder = new TextDecoderStream();
      const encoder = new TextEncoderStream();
      let buffer = "";

      const formatStream = new TransformStream({
        transform(chunk, controller) {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || "";
          for (const line of lines) {
            // Add a dim grey pipe prefix to separate server logs from application logic
            controller.enqueue(`\x1b[90m│\x1b[0m ${line}\n`);
          }
        },
        flush(controller) {
          if (buffer) {
            controller.enqueue(`\x1b[90m│\x1b[0m ${buffer}\n`);
          }
        }
      });

      handle.stderr
        .pipeThrough(decoder)
        .pipeThrough(formatStream)
        .pipeThrough(encoder)
        .pipeTo(ctx.stderr, { preventClose: true })
        .catch(console.error);
    }


    const urls = await handle.urls;
    if (!urls || urls.length === 0) throw new Error("No serve URLs allocated");
    const baseUrl = new URL(urls[0]).origin;

    console.log(`[+] Waiting for server at ${baseUrl}...`);
    await waitForServer(`${baseUrl}/health`, handle);
    console.log("[+] Server ready. Sending prompt...");

    const startTime = Date.now();
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: "You are a poetic assistant." },
          { role: "user", content: "Explain what a sandbox is in 2 lines." },
        ],
      }),
    });

    if (!res.ok) throw new Error(`API Error: ${await res.text()}`);

    const { choices } = await res.json();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\n\x1b[32mSuccess! (${elapsed}s)\x1b[0m`);
    console.log("===\n" + choices[0].message.content + "\n===");

    handle.signal("SIGTERM");
    await handle.exitCode;
  },
};

/**
 * Polls the server health endpoint until it becomes responsive.
 * Races against the process's exitCode so it immediately fails if the server crashes.
 */
async function waitForServer(healthUrl, handle, maxRetries = 1200) {
  const abort = new AbortController();

  const exitPromise = handle.exitCode.then((code) => {
    abort.abort();
    throw new Error(`Server process died prematurely with exit code ${code}`);
  });

  const pollPromise = (async () => {
    for (let i = 0; i < maxRetries; i++) {
      if (abort.signal.aborted) return;
      try {
        if ((await fetch(healthUrl)).ok) return;
      } catch {
        // Server not yet listening
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("Llama server failed to initialize within the timeout.");
  })();

  return Promise.race([pollPromise, exitPromise]);
}
