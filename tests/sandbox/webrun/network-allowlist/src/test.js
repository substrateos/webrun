export default async function(ctx) {
    const resp = await fetch("https://example.com");
    if (resp.ok) {
        console.log("FETCH_ALLOWED");
    } else {
        console.error("FETCH_FAILED:", resp.status);
        throw new Error("Fetch Failed");
    }
}
