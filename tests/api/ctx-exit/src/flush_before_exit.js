export default async function(ctx) {
    console.log("STDOUT_BEFORE_EXIT");
    console.error("STDERR_BEFORE_EXIT");
    ctx.exit(0);
}
