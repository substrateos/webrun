export async function testMatchingSuite(t) {
    await t.run("sub_test_only", () => {
        t.log("MATCHING_SUB_EXECUTED");
    });
    await t.run("other_sub", () => {
        throw new Error("SHOULD_NOT_EXECUTE_OTHER_SUB");
    });
}
