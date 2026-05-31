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
    console.log("[+] Launching llama-server...");
    const handle = await ctx.run([
      "--serve",
      "llama-server",
      "--hf-repo", "TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF",
      "--hf-file", "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf",
      "--host", "127.0.0.1",
    ]);

    const urls = await handle.urls;
    if (!urls || urls.length === 0) throw new Error("No serve URLs allocated");
    const baseUrl = new URL(urls[0]).origin;

    console.log(`[+] Waiting for server at ${baseUrl}...`);
    await waitForServer(`${baseUrl}/health`);
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
 */
async function waitForServer(healthUrl, maxRetries = 120) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if ((await fetch(healthUrl)).ok) return;
    } catch {
      // Server not yet listening
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Llama server failed to initialize within the timeout.");
}
