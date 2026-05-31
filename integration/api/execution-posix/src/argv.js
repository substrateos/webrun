export default async function(ctx) {
    const { argv } = ctx;
    if (!argv || argv.length !== 4) throw new Error("argv length mismatch");
    if (!argv[0].includes("webrun")) throw new Error("argv[0] does not contain webrun executable name");
    if (argv[1] !== "src/argv.js") throw new Error("argv[1] is not target script");
    if (argv[2] !== "--mode") throw new Error("argv[2] is not --mode");
    if (argv[3] !== "demo") throw new Error("argv[3] is not demo");
    console.log("ARGV_OK");
}
