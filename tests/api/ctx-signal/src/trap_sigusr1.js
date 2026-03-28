export default async function(ctx) {
    ctx.signal.addEventListener("SIGUSR1", () => {
        console.log("SIGUSR1_TRAPPED");
        ctx.exit(0);
    });
    console.log("READY");
    await new Promise(() => {}); // block forever
}
