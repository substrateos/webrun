export default async function(ctx) {
    // Synchronously block for 3 seconds — well over the 1s timeout.
    const end = Date.now() + 3000;
    while (Date.now() < end) { }
}
