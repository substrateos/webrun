export default async function(ctx) {
    // Intentionally throw standard synchronous permission error natively
    await fetch("https://example.com");
}
