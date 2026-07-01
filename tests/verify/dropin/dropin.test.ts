// tests/verify/dropin/dropin.test.ts
// The M5 verify slice's CI matrix. Positive fixtures drive the REAL scheduler + the REAL runTaskLoop
// drop-in transition + the REAL verifyAndMerge handback and distil a cross-task recording; probes are
// hand-crafted broken recordings (negative controls). Asserts the four M5 invariants —
// drop-in-frees-a-slot, handed-off-is-an-explicit-pause-state, commit-before-handback,
// worktree-retained-while-handed-off/needs-human — each with a probe that MUST FAIL. Vocabulary from
// ~/.claude/verification.md. Complementary to, and separate from, the untouched M2/M3/M4 slices.
import { describe, it, expect } from "vitest";
import { runDropinFixture, runAll, type Verdict } from "./runner";
import { DROPIN_INVARIANTS, runDropinInvariants } from "./invariants";
import { DROPIN_FIXTURES } from "./fixtures";
import { runFreesSlotScenario, runNeedsHumanRetainedScenario, type DropinRecording } from "./surface";

const failed = (r: DropinRecording) => runDropinInvariants(r).filter((c) => !c.ok).map((c) => c.name);

describe("verify/dropin: the CI matrix over every fixture", () => {
    it.each(DROPIN_FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS (observed and right)", async (_id, fixture) => {
        expect<Verdict>((await runDropinFixture(fixture)).verdict).toBe("PASS");
    });

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(DROPIN_FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it("runAll reports a verdict for every fixture, all PASS, none BLOCKED", async () => {
        const results = await runAll();
        expect(results).toHaveLength(DROPIN_FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});

describe("verify/dropin: the recording is the real units' behaviour", () => {
    it("drop into a running task → it hands off, the slot frees, the waiter starts (within cap)", async () => {
        const rec = await runFreesSlotScenario();
        expect(rec.slotFreedOnDropIn).toBe(true);
        expect(rec.maxRunningPerProject.P).toBeLessThanOrEqual(rec.cap);
        expect(rec.handedOffEverStarted).toBe(false); // the scheduler never auto-started the handed-off task
        expect(failed(rec)).toEqual([]);
    });

    it("commits at BOTH boundaries: the drop-in entry checkpoint and before the verify-&-merge", async () => {
        const rec = await runFreesSlotScenario();
        expect(rec.commitAtEntryBoundary).toBe(true);
        expect(rec.everyHandbackPrecededByCommit).toBe(true);
        expect(failed(rec)).toEqual([]);
    });

    it("a budget-exhausted task ends needs-human with its worktree RETAINED", async () => {
        const rec = await runNeedsHumanRetainedScenario();
        expect(rec.handedOffOrNeedsHumanWorktreeRetained).toBe(true);
        expect(failed(rec)).toEqual([]);
    });

    it("the evaluated invariant set equals the declared set", async () => {
        const rec = await runNeedsHumanRetainedScenario();
        expect(runDropinInvariants(rec).map((r) => r.name).sort()).toEqual(DROPIN_INVARIANTS.map((i) => i.name).sort());
    });
});

describe("verify/dropin: negative controls — each broken recording FAILS its named invariant", () => {
    const base: DropinRecording = {
        unit: "dropin", cap: 1, maxRunningPerProject: { P: 1 },
        slotFreedOnDropIn: true, handedOffEverStarted: false, commitAtEntryBoundary: true,
        everyHandbackPrecededByCommit: true, handedOffOrNeedsHumanWorktreeRetained: true, mergedOrAbandonedWorktreeRemoved: true,
        killedIterationRecordsNoResumableSession: true,
    };

    it("a slot that never freed FAILS drop-in-frees-a-slot", () => {
        expect(failed({ ...base, slotFreedOnDropIn: false })).toContain("drop-in-frees-a-slot");
    });
    it("running over cap FAILS drop-in-frees-a-slot", () => {
        expect(failed({ ...base, maxRunningPerProject: { P: 2 } })).toContain("drop-in-frees-a-slot");
    });
    it("a scheduler-started handed-off task FAILS handed-off-is-an-explicit-pause-state", () => {
        expect(failed({ ...base, handedOffEverStarted: true })).toContain("handed-off-is-an-explicit-pause-state");
    });
    it("a handback with no preceding commit FAILS commit-before-handback", () => {
        expect(failed({ ...base, everyHandbackPrecededByCommit: false })).toContain("commit-before-handback");
        expect(failed({ ...base, commitAtEntryBoundary: false })).toContain("commit-before-handback");
    });
    it("a removed handed-off worktree FAILS worktree-retained-while-handed-off/needs-human", () => {
        expect(failed({ ...base, handedOffOrNeedsHumanWorktreeRetained: false })).toContain("worktree-retained-while-handed-off/needs-human");
    });
    it("a killed iteration recorded as resumable FAILS killed-iteration-has-no-resumable-session", () => {
        expect(failed({ ...base, killedIterationRecordsNoResumableSession: false })).toContain("killed-iteration-has-no-resumable-session");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = null as unknown as DropinRecording; // property access throws inside predicates
        const results = runDropinInvariants(garbage);
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });
});
