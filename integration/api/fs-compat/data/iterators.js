export default async function(ctx) {
    const root = ctx.dir;
    await root.getFileHandle("file_a.txt", { create: true });
    await root.getDirectoryHandle("dir_b", { create: true });

    const entries = [];
    for await (const [name, handle] of root.entries()) {
        entries.push(`${name}:${handle.kind}`);
    }

    const keys = [];
    for await (const name of root.keys()) keys.push(name);

    const values = [];
    for await (const handle of root.values()) values.push(handle.kind);

    const defaultIter = [];
    for await (const [name, handle] of root) defaultIter.push(name);

    if (!entries.includes("file_a.txt:file") || !entries.includes("dir_b:directory")) throw new Error("entries() failed");
    if (!keys.includes("file_a.txt") || !keys.includes("dir_b")) throw new Error("keys() failed");
    if (!values.includes("file") || !values.includes("directory")) throw new Error("values() failed");
    if (!defaultIter.includes("file_a.txt") || !defaultIter.includes("dir_b")) throw new Error("[Symbol.asyncIterator]() failed");

    console.log("ITERATORS_OK");
}
