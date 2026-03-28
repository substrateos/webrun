export default async function(ctx) {
    const a = [];
    return new Promise((resolve) => {
        setInterval(() => {
            for(let i=0; i<100; i++) {
                a.push(new Uint8Array(1024 * 1024));
            }
        }, 50);
    });
}
