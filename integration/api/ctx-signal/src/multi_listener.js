export default async function(ctx) {
    ctx.signal.addEventListener("SIGTERM", () => console.log("FIRST"));
    ctx.signal.addEventListener("SIGTERM", (e) => {
        e.preventDefault();
        console.log("SECOND");
        ctx.exit(0);
    });
    console.log("READY");
    await new Promise(() => {}); // block forever
}
