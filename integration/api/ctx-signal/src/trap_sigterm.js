export default async function(ctx) {
    ctx.signal.addEventListener("SIGTERM", (e) => {
        e.preventDefault();
        console.log("SIGTERM_TRAPPED");
        ctx.exit(0);
    });
    console.log("READY");
    await new Promise(() => {}); // block forever
}
