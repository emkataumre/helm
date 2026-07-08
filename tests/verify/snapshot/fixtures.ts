// tests/verify/snapshot/fixtures.ts
// Two kinds of fixture. POSITIVE fixtures are event scripts run through the REAL reducer — every
// invariant must hold. PROBES are hand-crafted BROKEN snapshots (negative controls): each MUST FAIL
// its named invariant, proving the harness catches a lie and isn't just replaying happy paths.
import type { EngineSnapshot, SnapshotEvent } from "../../../src/shared/types";

export interface PositiveFixture { id: string; probe?: false; events: SnapshotEvent[] }
export interface ProbeFixture { id: string; probe: true; snapshot: EngineSnapshot; mustFail: string }
export type SnapshotFixture = PositiveFixture | ProbeFixture;

// A clean green first pass: assistant + tool-use + gates, real usage, a single green iteration.
export const GREEN_RUN: SnapshotEvent[] = [
    { type: "iteration-start", index: 0 },
    { type: "assistant", index: 0, text: "reading .ralph/progress.md" },
    { type: "tool-use", index: 0, name: "Bash" },
    { type: "gate", index: 0, label: "check: green" },
    { type: "gate", index: 0, label: "acceptance: green" },
    { type: "usage", index: 0, tokens: { input: 1200, output: 340, cacheRead: 5000, cacheCreation: 800, costUsd: 0.21 }, durationMs: 42000, sessionId: "sess-0" },
    { type: "iteration-end", index: 0, verdict: "green", commitSha: "abc123" },
    { type: "status", status: "merged" },
];

// A red check that retries and lands green on the second iteration: totals must accumulate.
export const FAILED_THEN_GREEN: SnapshotEvent[] = [
    { type: "iteration-start", index: 0 },
    { type: "assistant", index: 0, text: "first attempt" },
    { type: "gate", index: 0, label: "check: failed" },
    { type: "usage", index: 0, tokens: { input: 1000, output: 200, cacheRead: 0, cacheCreation: 0, costUsd: 0.10 }, durationMs: 30000, sessionId: "sess-0" },
    { type: "iteration-end", index: 0, verdict: "failed", commitSha: "aaa111" },
    { type: "iteration-start", index: 1 },
    { type: "assistant", index: 1, text: "second attempt" },
    { type: "tool-use", index: 1, name: "Edit" },
    { type: "gate", index: 1, label: "check: green" },
    { type: "usage", index: 1, tokens: { input: 1100, output: 260, cacheRead: 4000, cacheCreation: 500, costUsd: 0.15 }, durationMs: 35000, sessionId: "sess-1" },
    { type: "iteration-end", index: 1, verdict: "green", commitSha: "bbb222" },
    { type: "status", status: "merged" },
];

const noTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 });

// Probe 1 — a non-monotonic token series (negative output). totals is set to match the (negative)
// sum so ONLY the negativity trips token-accounting-monotonic, not reconciliation.
export const NEGATIVE_TOKENS: EngineSnapshot = {
    taskId: "t", status: "running", currentIteration: null,
    iterations: [{ index: 0, verdict: "green", tokens: { input: 10, output: -5, cacheRead: 0, cacheCreation: 0, costUsd: 0.1 }, durationMs: null, sessionId: null, commitSha: "a", outputTail: null }],
    totals: { input: 10, output: -5, cacheRead: 0, cacheCreation: 0, costUsd: 0.1 },
    feed: [], feedEventsConsumed: 0, terminalReason: null,
};

// Probe 2 — an orphan feed entry pointing at an iteration that doesn't exist.
export const ORPHAN_FEED: EngineSnapshot = {
    taskId: "t", status: "running", currentIteration: null,
    iterations: [{ index: 0, verdict: null, tokens: noTokens(), durationMs: null, sessionId: null, commitSha: null, outputTail: null }],
    totals: noTokens(),
    feed: [{ iterationIndex: 5, kind: "assistant", text: "from a phantom iteration" }],
    feedEventsConsumed: 1, terminalReason: null,
};

// Probe 2b — a fabricated feed (length exceeds the count of events that produced it).
export const FEED_EXCEEDS_CONSUMED: EngineSnapshot = {
    taskId: "t", status: "running", currentIteration: null,
    iterations: [{ index: 0, verdict: null, tokens: noTokens(), durationMs: null, sessionId: null, commitSha: null, outputTail: null }],
    totals: noTokens(),
    feed: [{ iterationIndex: 0, kind: "assistant", text: "a" }, { iterationIndex: 0, kind: "assistant", text: "b" }],
    feedEventsConsumed: 1, terminalReason: null,
};

// Probe 3 — a garbage snapshot: no surface at all.
export const GARBAGE = {} as EngineSnapshot;

export const SNAPSHOT_FIXTURES: SnapshotFixture[] = [
    { id: "green-run", events: GREEN_RUN },
    { id: "failed-then-green", events: FAILED_THEN_GREEN },
    { id: "negative-token-series", probe: true, snapshot: NEGATIVE_TOKENS, mustFail: "token-accounting-monotonic" },
    { id: "orphan-feed-entry", probe: true, snapshot: ORPHAN_FEED, mustFail: "activity-feed-matches-events" },
    { id: "garbage-snapshot", probe: true, snapshot: GARBAGE, mustFail: "surface-present" },
];
