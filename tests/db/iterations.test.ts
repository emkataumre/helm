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

it("a fresh iteration has NULL token/duration fields", () => {
    const db = openDb(":memory:");
    const it = addIteration(db, "t", 0);
    expect(it.inputTokens).toBeNull();
    expect(it.outputTokens).toBeNull();
    expect(it.cacheReadTokens).toBeNull();
    expect(it.cacheCreationTokens).toBeNull();
    expect(it.costUsd).toBeNull();
    expect(it.durationMs).toBeNull();
    db.close();
});

it("persists per-iteration tokens + duration and reads them back", () => {
    const db = openDb(":memory:");
    const a = addIteration(db, "t", 0);
    finishIteration(db, a.id, {
        gateVerdict: "green", outputTail: "ok",
        inputTokens: 14861, outputTokens: 294, cacheReadTokens: 85709, cacheCreationTokens: 20148,
        costUsd: 0.3259895, durationMs: 46460,
    });
    const got = listIterations(db, "t")[0];
    expect(got.inputTokens).toBe(14861);
    expect(got.outputTokens).toBe(294);
    expect(got.cacheReadTokens).toBe(85709);
    expect(got.cacheCreationTokens).toBe(20148);
    expect(got.costUsd).toBeCloseTo(0.3259895);
    expect(got.durationMs).toBe(46460);
    db.close();
});

it("a finish patch that omits tokens leaves those columns NULL", () => {
    const db = openDb(":memory:");
    const a = addIteration(db, "t", 0);
    finishIteration(db, a.id, { gateVerdict: "failed", outputTail: "boom" });
    const got = listIterations(db, "t")[0];
    expect(got.gateVerdict).toBe("failed");
    expect(got.inputTokens).toBeNull();
    expect(got.costUsd).toBeNull();
    expect(got.durationMs).toBeNull();
    db.close();
});
