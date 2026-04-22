Deno.test("Is Deno deleted?", () => {
    console.error("Is Deno defined?", typeof (globalThis as any).Deno);
});
