export default async function(ctx) {
    const { args, flags } = ctx;
    const pos = [...args];
    if (pos[0] !== "positionalValue") throw new Error("Positional array overwritten");
    if (flags[""] !== "hacked") throw new Error("Empty flag missing");
    console.log("REACHED");
}
