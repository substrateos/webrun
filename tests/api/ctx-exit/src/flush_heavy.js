export default async function(ctx) {
    for (let i = 0; i < 100; i++) {
        console.log(`LINE_${i}`);
    }
    console.error("STDERR_FINAL");
    ctx.exit(0);
}
