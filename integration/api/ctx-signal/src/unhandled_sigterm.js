export default async function(ctx) {
    console.log("READY");
    await new Promise(() => {}); // block forever, no signal handler
}
