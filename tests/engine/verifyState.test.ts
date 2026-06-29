// tests/engine/verifyState.test.ts
import { describe, it, expect } from "vitest";
import { emptySnapshot, applyEvent, snapshotFromRows } from "../../src/main/engine/verifyState";
import type { EngineSnapshot, SnapshotEvent, TokenTotals, Iteration } from "../../src/shared/types";

const tokens = (over: Partial<TokenTotals> = {}): TokenTotals =>
    ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, ...over });

function reduce(taskId: string, events: SnapshotEvent[]): EngineSnapshot {
    return events.reduce((draft, e) => applyEvent(draft, e), emptySnapshot(taskId));
}

function iterationRow(over: Partial<Iteration>): Iteration {
    return {
        id: "i", taskId: "t", index: 0, sessionId: null, startedAt: 0, endedAt: null,
        gateVerdict: null, commitSha: null, outputTail: null,
        inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
        costUsd: null, durationMs: null, ...over,
    };
}

describe("applyEvent", () => {
    it("mutates the caller-owned draft and returns the same object", () => {
        const draft = emptySnapshot("t");
        const out = applyEvent(draft, { type: "iteration-start", index: 0 });
        expect(out).toBe(draft);
    });

    it("a green single-iteration script yields the right series, feed, totals, and a cleared currentIteration", () => {
        const s = reduce("t", [
            { type: "iteration-start", index: 0 },
            { type: "assistant", index: 0, text: "working on it" },
            { type: "tool-use", index: 0, name: "Bash" },
            { type: "gate", index: 0, label: "check: green" },
            { type: "usage", index: 0, tokens: tokens({ input: 100, output: 50, cacheRead: 200, cacheCreation: 30, costUsd: 0.5 }), durationMs: 1000, sessionId: "s0" },
            { type: "iteration-end", index: 0, verdict: "green", commitSha: "sha0" },
            { type: "status", status: "merged" },
        ]);
        expect(s.iterations).toHaveLength(1);
        expect(s.iterations[0]).toMatchObject({ index: 0, verdict: "green", commitSha: "sha0", sessionId: "s0", durationMs: 1000 });
        expect(s.iterations[0].tokens).toEqual(tokens({ input: 100, output: 50, cacheRead: 200, cacheCreation: 30, costUsd: 0.5 }));
        expect(s.feed.map((e) => e.kind)).toEqual(["assistant", "tool-use", "gate"]);
        expect(s.feed.every((e) => e.iterationIndex === 0)).toBe(true);
        expect(s.feedEventsConsumed).toBe(3);
        expect(s.totals).toEqual(tokens({ input: 100, output: 50, cacheRead: 200, cacheCreation: 30, costUsd: 0.5 }));
        expect(s.status).toBe("merged");
        expect(s.currentIteration).toBeNull();
    });

    it("a gate event advances the phase (check → checking, acceptance → accepting)", () => {
        const s = reduce("t", [
            { type: "iteration-start", index: 0 },
            { type: "gate", index: 0, label: "check passed" },
        ]);
        expect(s.currentIteration?.phase).toBe("checking");
        applyEvent(s, { type: "gate", index: 0, label: "acceptance passed" });
        expect(s.currentIteration?.phase).toBe("accepting");
    });

    it("accumulates totals across multiple iterations", () => {
        const s = reduce("t", [
            { type: "iteration-start", index: 0 },
            { type: "usage", index: 0, tokens: tokens({ input: 10, output: 5, costUsd: 0.1 }) },
            { type: "iteration-end", index: 0, verdict: "failed", commitSha: "a" },
            { type: "iteration-start", index: 1 },
            { type: "usage", index: 1, tokens: tokens({ input: 20, output: 7, costUsd: 0.2 }) },
            { type: "iteration-end", index: 1, verdict: "green", commitSha: "b" },
        ]);
        expect(s.iterations).toHaveLength(2);
        expect(s.totals.input).toBe(30);
        expect(s.totals.output).toBe(12);
        expect(s.totals.costUsd).toBeCloseTo(0.3);
    });

    it("bounds the feed ring at 200 but never decrements feedEventsConsumed (feed.length ≤ consumed)", () => {
        const events: SnapshotEvent[] = [{ type: "iteration-start", index: 0 }];
        for (let i = 0; i < 250; i++) events.push({ type: "assistant", index: 0, text: `m${i}` });
        const s = reduce("t", events);
        expect(s.feed.length).toBe(200);
        expect(s.feedEventsConsumed).toBe(250);
        expect(s.feed.length).toBeLessThanOrEqual(s.feedEventsConsumed);
        expect(s.feed[s.feed.length - 1].text).toBe("m249"); // ring keeps the most recent
    });

    it("status carries a terminalReason when given", () => {
        const s = reduce("t", [{ type: "status", status: "needs-human", terminalReason: "merge conflict" }]);
        expect(s.status).toBe("needs-human");
        expect(s.terminalReason).toBe("merge conflict");
    });
});

describe("snapshotFromRows", () => {
    it("rebuilds iterations + totals from DB rows with an EMPTY feed (the ring is in-memory only)", () => {
        const rows: Iteration[] = [
            iterationRow({ index: 0, gateVerdict: "failed", commitSha: "a", sessionId: "s0", inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheCreationTokens: 2, costUsd: 0.1, durationMs: 100 }),
            iterationRow({ index: 1, gateVerdict: "green", commitSha: "b", sessionId: "s1", inputTokens: 20, outputTokens: 7, cacheReadTokens: 3, cacheCreationTokens: 4, costUsd: 0.2, durationMs: 200 }),
        ];
        const s = snapshotFromRows({ id: "t", status: "merged", failureReason: null }, rows);
        expect(s.feed).toEqual([]);
        expect(s.feedEventsConsumed).toBe(0);
        expect(s.iterations).toHaveLength(2);
        expect(s.iterations[0]).toMatchObject({ index: 0, verdict: "failed", commitSha: "a", sessionId: "s0", durationMs: 100 });
        expect(s.iterations[1].verdict).toBe("green");
        expect(s.totals.input).toBe(30);
        expect(s.totals.output).toBe(12);
        expect(s.totals.costUsd).toBeCloseTo(0.3);
        expect(s.status).toBe("merged");
        expect(s.currentIteration).toBeNull();
    });

    it("carries the task's failureReason as terminalReason and zero-fills NULL token columns", () => {
        const rows = [iterationRow({ index: 0, gateVerdict: "failed", commitSha: "a" })]; // all token cols NULL
        const s = snapshotFromRows({ id: "t", status: "needs-human", failureReason: "iteration cap reached (8)" }, rows);
        expect(s.terminalReason).toBe("iteration cap reached (8)");
        expect(s.iterations[0].tokens).toEqual(tokens());
        expect(s.totals).toEqual(tokens());
    });
});
