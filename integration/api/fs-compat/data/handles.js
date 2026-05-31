export default async function(ctx) {
    const root = ctx.dir;
    const subDir = await root.getDirectoryHandle("nested_dir", { create: true });
    const fh1 = await subDir.getFileHandle("target.txt", { create: true });
    const fh2 = await subDir.getFileHandle("target.txt", { create: false });
    const subDir2 = await root.getDirectoryHandle("nested_dir", { create: false });

    if (!(await fh1.isSameEntry(fh2))) throw new Error("isSameEntry false negative for identical files");
    if (await fh1.isSameEntry(subDir)) throw new Error("isSameEntry false positive for different kinds");
    if (!(await subDir.isSameEntry(subDir2))) throw new Error("isSameEntry false negative for identical directories");

    const resolvePath = await root.resolve(fh1);
    if (!resolvePath || resolvePath.join("/") !== "nested_dir/target.txt") throw new Error("resolve() failed to build relative path");

    const outsideResolve = await subDir.resolve(root);
    if (outsideResolve !== null) throw new Error("resolve() should return null for non-descendants");

    console.log("HANDLES_OK");
}
