export default async function(ctx) {
    await new Promise(r => setTimeout(r, 1000));
    console.log("MIGRATION_PROXY_OK");
}
