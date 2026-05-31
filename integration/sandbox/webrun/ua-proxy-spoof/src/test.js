export default async function() {
    const { map } = await import("https://esm.sh/lodash-es@4.17.21?dev=1");
    console.log("IMPORT_OK:" + map([1, 2, 3], x => x * 2).join(","));
}
