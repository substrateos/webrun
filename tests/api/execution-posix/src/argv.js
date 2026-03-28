export default async function(ctx) {
    const { argv } = ctx;
    if (!argv || argv.length !== 5) throw new Error("argv length mismatch");
    if (!argv[0].includes("webrun")) throw new Error("argv[0] does not contain webrun executable name");
    if (argv[1] !== "--module") throw new Error("argv[1] is not --module");
    if (argv[2] !== "src/argv.js") throw new Error("argv[2] is not target script");
    if (argv[3] !== "--mode") throw new Error("argv[3] is not --mode");
    if (argv[4] !== "demo") throw new Error("argv[4] is not demo");
    console.log("ARGV_OK");
}
