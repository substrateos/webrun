export default async function() {
    const { basename } = await import("https://deno.land/std@0.224.0/path/mod.ts");
    console.log("IMPORT_OK:" + basename("/foo/bar.txt"));
}
