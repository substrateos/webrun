export default async function(ctx) {
  const isMac = navigator.userAgent.includes("Mac OS");
  const curlPath = isMac ? "/usr/bin/curl" : "curl";
  const opensslPath = isMac ? "/usr/bin/openssl" : "openssl";

  const certPath = new URL("test-cert.pem", import.meta.url).pathname;
  const keyPath = new URL("test-key.pem", import.meta.url).pathname;

  // Spin up local OpenSSL TLS server (detach stdin so it doesn't block)
  const server = await ctx.run([
    opensslPath, "s_server", 
    "-cert", certPath, 
    "-key", keyPath, 
    "-accept", "8443", 
    "-www"
  ]);
  server.stdout.pipeTo(new WritableStream()).catch(() => {});
  server.stderr.pipeTo(new WritableStream()).catch(() => {});

  // Wait briefly for server to bind
  await new Promise(r => setTimeout(r, 1000));

  try {
    // Connect to it using native curl with a strict timeout to prevent hangs
    const client = await ctx.run([
      curlPath, "-v", "--max-time", "3", "--connect-timeout", "2", "https://127.0.0.1:8443/"
    ]);

    // Sink streams to prevent backpressure from blocking exit
    client.stdout.pipeTo(new WritableStream()).catch(() => {});
    client.stderr.pipeTo(new WritableStream()).catch(() => {});

    // Wait for curl with a fallback timeout
    let code = -1;
    try {
      code = await Promise.race([
        client.exitCode,
        new Promise((_, rej) => setTimeout(() => rej(new Error("Curl timeout")), 10000))
      ]);
    } catch (e) {
      client.signal("SIGKILL");
    }

    // Curl should exit with 60 (PEER_FAILED_VERIFICATION) if OS TLS works.
    // If sandbox breaks TLS (like missing Keychain paths), it crashes with internal OS errors.
    if (code === 60) {
      console.log("TLS_VERIFICATION_FAILED_PROPERLY");
    } else {
      console.error(`Expected code 60, got ${code}`);
      throw new Error("TLS test failed.");
    }
  } finally {
    // Always kill the server to prevent port leaks across test runs
    server.signal("SIGKILL");
  }
}
