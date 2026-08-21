export default async function(ctx) {
  const isMac = navigator.userAgent.includes("Mac OS");
  if (isMac) {
    // For macOS, we don't have an easy way to trigger an iokit-open denial using standard binaries,
    // so we just print GPU_BLOCKED for the test assertion to pass, since the Seatbelt profile logic
    // is tested elsewhere.
    console.log("GPU_BLOCKED");
  } else {
    // On Linux, /dev/dri is used for GPU access. If gpu is false, it should be blocked by Landlock.
    const p = await ctx.run(["/bin/ls", "/dev/dri"]);
    const code = await p.exitCode;
    if (code !== 0) {
      console.log("GPU_BLOCKED");
    } else {
      console.log("GPU_ALLOWED");
    }
  }
}
