export default async function(ctx) {
    console.log(ctx.signal.aborted === false ? "ABORTED_FALSE" : "ABORTED_TRUE");
    console.log(ctx.signal instanceof AbortSignal ? "IS_ABORT_SIGNAL" : "NOT_ABORT_SIGNAL");
}
