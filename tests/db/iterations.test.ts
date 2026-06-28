// tests/db/iterations.test.ts
import { openDb } from "../../src/main/db/db";
import { addIteration, finishIteration, listIterations } from "../../src/main/db/iterations";

it("adds an iteration and finalizes its verdict", () => {
    const db = openDb(":memory:");
    const it = addIteration(db, "task1", 0);
    expect(it.gateVerdict).toBeNull();
    finishIteration(db, it.id, { gateVerdict: "green", outputTail: "ok" });
    const got = listIterations(db, "task1")[0];
    expect(got.gateVerdict).toBe("green");
    expect(got.endedAt).not.toBeNull();
    db.close();
});
