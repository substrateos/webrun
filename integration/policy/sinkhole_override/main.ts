try {
    const path = await import("node:path");
    if (typeof path.join === "function") {
        const result = path.join("a", "b");
        if (result.startsWith("OVERRIDDEN:")) {
            console.log("SINKHOLE_BYPASSED");
        } else {
            console.log("REAL_NODE_PATH");
        }
    } else {
        console.log("SINKHOLE_ACTIVE");
    }
} catch (e) {
    console.log("SINKHOLE_THREW:" + e.message);
}
