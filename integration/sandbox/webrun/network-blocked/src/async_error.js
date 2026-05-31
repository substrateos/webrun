export default async function(ctx) {
    // Intentionally dangling unhandled promise catching the unhandledrejection event
    setTimeout(() => fetch("https://example.com"), 10);
    await new Promise(r => setTimeout(r, 100));
}
