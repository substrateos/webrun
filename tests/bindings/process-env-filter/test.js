export default async function(ctx) {
    const res = await fetch(ctx.bindings.filtered);
    const json = await res.json();
    if (json.leaked !== undefined) throw new Error("Child inherited unlisted host environment: " + json.leaked);
    if (json.allowed !== "secret") throw new Error("Child missing explicit local environment: " + json.allowed);
    console.log("ENV_FILTER_OK");
}
