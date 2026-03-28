export default async function(ctx) {
    if (!ctx.stdin || !ctx.stdout || !ctx.stderr) throw new Error("Missing stream primitives.");
    const writer = ctx.stdout.getWriter();
    await writer.write(new TextEncoder().encode("STREAMS_OK"));
    writer.releaseLock();
}
