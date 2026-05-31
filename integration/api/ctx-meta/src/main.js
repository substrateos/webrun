// ctx-meta integration test: verifies ctx.meta.url and ctx.meta.resolve().

export default {
    async main(args, env, ctx) {
        // ctx.meta.url should be a file:// URL ending with our script name.
        if (typeof ctx.meta?.url !== "string") {
            throw new Error("ctx.meta.url is not a string: " + typeof ctx.meta?.url);
        }
        if (!ctx.meta.url.startsWith("file://")) {
            throw new Error("ctx.meta.url should start with file://, got: " + ctx.meta.url);
        }
        if (!ctx.meta.url.endsWith("main.js")) {
            throw new Error("ctx.meta.url should end with main.js, got: " + ctx.meta.url);
        }
        console.log("META_URL_OK");

        // ctx.meta.resolve should be a function.
        if (typeof ctx.meta.resolve !== "function") {
            throw new Error("ctx.meta.resolve is not a function: " + typeof ctx.meta.resolve);
        }

        // Relative resolution.
        const sibling = ctx.meta.resolve("./sibling.js");
        if (!sibling.endsWith("/src/sibling.js")) {
            throw new Error("resolve('./sibling.js') should end with /src/sibling.js, got: " + sibling);
        }
        console.log("META_RESOLVE_RELATIVE_OK");

        // Parent-relative resolution.
        const parent = ctx.meta.resolve("../other.js");
        if (!parent.endsWith("/other.js") || parent.includes("/src/")) {
            throw new Error("resolve('../other.js') should resolve to parent dir, got: " + parent);
        }
        console.log("META_RESOLVE_PARENT_OK");

        // Absolute URL passes through.
        const abs = ctx.meta.resolve("https://example.com/lib.js");
        if (abs !== "https://example.com/lib.js") {
            throw new Error("resolve absolute URL should pass through, got: " + abs);
        }
        console.log("META_RESOLVE_ABSOLUTE_OK");
    }
};
