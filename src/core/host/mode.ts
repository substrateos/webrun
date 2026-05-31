const MODULE_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".mts", ".jsx", ".tsx", ".wasm", ".html"]);

export default function inferMode(target: string): "module" | "binary" {
    if (target.startsWith("@")) return "binary";
    if (/^https?:\/\/|^data:/.test(target)) return "module";
    const dotIdx = target.lastIndexOf(".");
    if (dotIdx !== -1 && MODULE_EXTENSIONS.has(target.substring(dotIdx))) return "module";
    return "binary";
}
