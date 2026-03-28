export default async function(ctx) {
    const root = ctx.dir;
    const fh = await root.getFileHandle("stream.txt", { create: true });
    const w = await fh.createWritable();
    await w.write("streaming_data_test");
    await w.close();

    const file = await fh.getFile();
    if (!(file instanceof Blob)) throw new Error("getFile() must return a Blob subclass");
    if (file.size !== 19) throw new Error("File size metadata is incorrect");

    const stream = file.stream();
    const reader = stream.getReader();
    const { value, done } = await reader.read();

    if (done) throw new Error("Stream closed prematurely");
    const text = new TextDecoder().decode(value);
    if (text !== "streaming_data_test") throw new Error("Stream chunk data mismatch: " + text);
}
