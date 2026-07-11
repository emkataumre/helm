// tests/verify/feedback/feedback.test.ts
// The M18 verify slice's CI matrix. The positive fixture drives the REAL kernel — the real runTaskLoop
// through a recycled conflict, the recycle bound, a non-recyclable merge-setup park, the real DB behind
// setStatus + recordRecycled (the ipc wiring shape), and the informed resume — and distils a recording;
// probes are hand-crafted broken recordings (negative controls). Asserts the five invariants —
// merge-loss-recycles-not-parks, recycle-bounded, non-recyclable-kinds-still-park,
// recycled-losses-still-ledgered, resume-carries-parked-cause — each with a probe that MUST FAIL.
// Vocabulary from ~/.claude/verification.md. The real racing-fleet path (two live agents actually
// colliding on integration) is NOT headless-reachable → the scripts/live-feedback/ driver carries it.
import { describe, it, expect } from "vitest";
import { runFeedbackFixture, runAll, type Verdict } from "./runner";
import { FEEDBACK_INVARIANTS, runFeedbackInvariants } from "./invariants";
import { FEEDBACK_FIXTURES } from "./fixtures";
import { runFeedbackScenario, BASELINE, type FeedbackRecording } from "./surface";

const failed = (r: FeedbackRecording) => runFeedbackInvariants(r).filter((c) => !c.ok).map((c) => c.name);

describe("verify/feedback: the CI matrix over every fixture", () => {
    it.each(FEEDBACK_FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS (observed and right)", async (_id, fixture) => {
        expect<Verdict>((await runFeedbackFixture(fixture)).verdict).toBe("PASS");
    });

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(FEEDBACK_FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it("has a probe for EVERY declared invariant (each must be catchable)", () => {
        const covered = new Set(FEEDBACK_FIXTURES.filter((f) => f.probe).map((f) => (f as { mustFail: string }).mustFail));
        expect([...covered].sort()).toEqual(FEEDBACK_INVARIANTS.map((i) => i.name).sort());
    });

    it("runAll reports a verdict for every fixture, all PASS, none BLOCKED", async () => {
        const results = await runAll();
        expect(results).toHaveLength(FEEDBACK_FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});

describe("verify/feedback: the recording is the real kernel's behaviour", () => {
    it("the real kernel run satisfies all five invariants", async () => {
        expect(failed(await runFeedbackScenario())).toEqual([]);
    });

    it("the evaluated invariant set equals the declared set", async () => {
        expect(runFeedbackInvariants(await runFeedbackScenario()).map((r) => r.name).sort())
            .toEqual(FEEDBACK_INVARIANTS.map((i) => i.name).sort());
    });
});

describe("verify/feedback: negative controls — each broken recording FAILS its named invariant", () => {
    it("a conflict that parks on first loss FAILS merge-loss-recycles-not-parks", () => {
        expect(failed({ ...BASELINE, conflict: { ...BASELINE.conflict, finalStatus: "needs-human", needsHumanWrites: 1 } }))
            .toContain("merge-loss-recycles-not-parks");
    });
    it("a blind retry (cause missing from the prompt) FAILS merge-loss-recycles-not-parks", () => {
        expect(failed({ ...BASELINE, conflict: { ...BASELINE.conflict, retryPromptHasCause: false } }))
            .toContain("merge-loss-recycles-not-parks");
    });
    it("an open no-op trap (condition not extended) FAILS merge-loss-recycles-not-parks", () => {
        expect(failed({ ...BASELINE, conflict: { ...BASELINE.conflict, retryPromptDemandsMerge: false } }))
            .toContain("merge-loss-recycles-not-parks");
    });
    it("an unbounded recycler FAILS recycle-bounded", () => {
        expect(failed({ ...BASELINE, bounded: { ...BASELINE.bounded, mergeAttempts: 9 } })).toContain("recycle-bounded");
    });
    it("a bound that parks under a wrong kind FAILS recycle-bounded", () => {
        expect(failed({ ...BASELINE, bounded: { ...BASELINE.bounded, parkedKind: "cost-cap" } })).toContain("recycle-bounded");
    });
    it("a recycled setup failure FAILS non-recyclable-kinds-still-park", () => {
        expect(failed({ ...BASELINE, nonRecyclable: { finalStatus: "merged", mergeAttempts: 2, recycles: 1 } }))
            .toContain("non-recyclable-kinds-still-park");
    });
    it("an invisible recycle FAILS recycled-losses-still-ledgered", () => {
        expect(failed({ ...BASELINE, ledger: { ...BASELINE.ledger, recycledRows: 0, recycledKinds: [], resolutions: [] } }))
            .toContain("recycled-losses-still-ledgered");
    });
    it("a recycle row left OPEN (unstamped) FAILS recycled-losses-still-ledgered", () => {
        expect(failed({ ...BASELINE, ledger: { ...BASELINE.ledger, resolutions: [null], openRowsAfterMerge: 1 } }))
            .toContain("recycled-losses-still-ledgered");
    });
    it("an uninformed resume FAILS resume-carries-parked-cause", () => {
        expect(failed({ ...BASELINE, resume: { parkedPromptHasCause: false, cleanPromptSeeded: false } }))
            .toContain("resume-carries-parked-cause");
    });
    it("a clean resume that got seeded anyway FAILS resume-carries-parked-cause", () => {
        expect(failed({ ...BASELINE, resume: { parkedPromptHasCause: true, cleanPromptSeeded: true } }))
            .toContain("resume-carries-parked-cause");
    });
    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = null as unknown as FeedbackRecording; // property access throws inside predicates
        const results = runFeedbackInvariants(garbage);
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });
});
