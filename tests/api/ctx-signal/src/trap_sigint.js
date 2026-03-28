export default async function(ctx) {
    ctx.signal.addEventListener("SIGINT", (e) => {
        e.preventDefault();
        console.log("SIGINT_TRAPPED");
        ctx.exit(130);
    });
    console.log("READY");
    await new Promise(() => {}); // block forever
}
