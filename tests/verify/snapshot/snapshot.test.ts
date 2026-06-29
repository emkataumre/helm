// tests/verify/snapshot/snapshot.test.ts
// The M3 verify slice's CI matrix. The surface is the REAL EngineSnapshot built by the REAL reducer
// (verifyState.applyEvent) — the same object the cockpit reads — so these checks prove the running
// observability artifact, not a parallel model. Vocabulary + rules from ~/.claude/verification.md.
import { describe, it, expect } from "vitest";
import { runSnapshotFixture, runAll, buildSnapshot, type Verdict } from "./runner";
import { SNAPSHOT_INVARIANTS, runSnapshotInvariants } from "./invariants";
import {
    SNAPSHOT_FIXTURES, GREEN_RUN, NEGATIVE_TOKENS, ORPHAN_FEED, FEED_EXCEEDS_CONSUMED, GARBAGE,
} from "./fixtures";
import { emptySnapshot, applyEvent } from "../../../src/main/engine/verifyState";

const failedInvariants = (s: Parameters<typeof runSnapshotInvariants>[0]) =>
    runSnapshotInvariants(s).filter((c) => !c.ok).map((c) => c.name);

const reduceGreen = () => GREEN_RUN.reduce((d, e) => applyEvent(d, e), emptySnapshot("verify-task", "running"));

describe("verify/snapshot: the CI matrix over every fixture", () => {
    it.each(SNAPSHOT_FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS (observed and right)", (_id, fixture) => {
        expect<Verdict>(runSnapshotFixture(fixture).verdict).toBe("PASS");
    });

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(SNAPSHOT_FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it("runAll reports a verdict for every fixture and none are BLOCKED", () => {
        const results = runAll();
        expect(results).toHaveLength(SNAPSHOT_FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});

describe("verify/snapshot: the surface is the real reducer output", () => {
    it("a real green run holds every invariant", () => {
        expect(failedInvariants(reduceGreen())).toEqual([]);
    });

    it("the evaluated invariant set equals the declared set", () => {
        const names = runSnapshotInvariants(reduceGreen()).map((r) => r.name).sort();
        expect(names).toEqual(SNAPSHOT_INVARIANTS.map((i) => i.name).sort());
    });

    it("a probe snapshot really is the snapshot the runner verifies (no shadow object)", () => {
        expect(buildSnapshot({ id: "x", probe: true, snapshot: NEGATIVE_TOKENS, mustFail: "token-accounting-monotonic" })).toBe(NEGATIVE_TOKENS);
    });
});

describe("verify/snapshot: negative controls — each broken snapshot FAILS its named invariant", () => {
    it("a non-monotonic token series FAILS token-accounting-monotonic", () => {
        expect(failedInvariants(NEGATIVE_TOKENS)).toContain("token-accounting-monotonic");
    });

    it("an orphan feed entry (unknown iterationIndex) FAILS activity-feed-matches-events", () => {
        expect(failedInvariants(ORPHAN_FEED)).toContain("activity-feed-matches-events");
    });

    it("a fabricated feed (length > feedEventsConsumed) FAILS activity-feed-matches-events", () => {
        expect(failedInvariants(FEED_EXCEEDS_CONSUMED)).toContain("activity-feed-matches-events");
    });

    it("an empty/garbage snapshot FAILS surface-present", () => {
        expect(failedInvariants(GARBAGE)).toContain("surface-present");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const results = runSnapshotInvariants(GARBAGE); // accessing s.iterations on {} throws inside two predicates
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });
});
