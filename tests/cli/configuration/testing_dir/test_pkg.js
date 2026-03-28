export default async function(ctx) {
    const root = ctx.dir;
    const fh = await root.getFileHandle("test_write.txt", { create: true });
    const w = await fh.createWritable();
    await w.write("package_json_fallback_active");
    await w.close();
    console.log("PKG_JSON_FALLBACK_OK");
}
