// tests/db/iterations.test.ts
import { openDb } from "../../src/main/db/db";
import { addIteration, finishIteration, listIterations, latestSessionId } from "../../src/main/db/iterations";
import type { Iteration } from "../../src/shared/types";

// A compact Iteration factory for the pure latestSessionId tests (the fields it ignores stay null).
const mkIter = (index: number, sessionId: string | null): Iteration => ({
    id: `i${index}`, taskId: "t", index, sessionId, startedAt: 0, endedAt: null, gateVerdict: null,
    commitSha: null, outputTail: null, inputTokens: null, outputTokens: null, cacheReadTokens: null,
    cacheCreationTokens: null, costUsd: null, durationMs: null,
});

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

// M5: drop-in resumes the FRESHEST session — the highest-index iteration that captured one (including
// the just-killed in-flight one). A pure helper so the ipc drop-in handler stays glue.
describe("latestSessionId", () => {
    it("picks the highest-index iteration that has a session id", () => {
        expect(latestSessionId([mkIter(0, "s0"), mkIter(1, "s1"), mkIter(2, "s2")])).toBe("s2");
    });
    it("falls back to an earlier non-null session when the latest index has none", () => {
        expect(latestSessionId([mkIter(0, "s0"), mkIter(1, null)])).toBe("s0");
    });
    it("returns null when no iteration captured a session id", () => {
        expect(latestSessionId([mkIter(0, null), mkIter(1, null)])).toBeNull();
    });
    it("returns null for an empty list", () => {
        expect(latestSessionId([])).toBeNull();
    });
    it("is order-independent (reads by index, not array position)", () => {
        expect(latestSessionId([mkIter(2, "s2"), mkIter(0, "s0"), mkIter(1, "s1")])).toBe("s2");
    });
});
