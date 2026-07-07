// tests/verify/engine.test.ts
// Engine-first runtime verification for runTaskLoop — drives the REAL loop into known states,
// reads one machine-readable snapshot, asserts invariants. Vocabulary + rules from
// ~/.claude/verification.md. Lives under tests/ — zero production footprint.
import { describe, it, expect } from "vitest";
import { runScenario, runFixture, runAll, type Verdict } from "./runner";
import { INVARIANTS, runInvariants } from "./invariants";
import { FIXTURES } from "./fixtures";
import type { Snapshot } from "./surface";

describe("verify/surface: the snapshot reflects what the real loop did", () => {
    it("green-first-pass snapshots a clean, gated, single squash-merge", async () => {
        const s = await runScenario({ script: [{}] });
        expect(s.unit).toBe("runTaskLoop");
        expect(s.finalStatus).toBe("merged");
        expect(s.squashMergeApplied).toBe(true);
        expect(s.mergeApplications).toBe(1);
        expect(s.mergedWithoutGreenGate).toBe(false);
        expect(s.acceptanceRanGreenBeforeMerge).toBe(true);
        expect(s.worktreeRemoved).toBe(true);
        expect(s.branchKept).toBe(false);
        expect(s.iterationsRun).toBe(1);
    });

    it("red-then-green takes two iterations and still merges once", async () => {
        const s = await runScenario({ script: [{ checkGreen: false }, {}] });
        expect(s.finalStatus).toBe("merged");
        expect(s.iterationsRun).toBe(2);
        expect(s.mergeApplications).toBe(1);
    });
});

describe("verify/invariants: predicates hold, and catch a lie", () => {
    it("every invariant holds for a green run", async () => {
        const broken = runInvariants(await runScenario({ script: [{}] })).filter((r) => !r.ok);
        expect(broken).toEqual([]);
    });

    it("NEGATIVE CONTROL: a merged-without-acceptance snapshot FAILS the Layer-B invariants", () => {
        const lie: Snapshot = {
            unit: "runTaskLoop", finalStatus: "merged", iterationsRun: 1, iterationsFinished: 1,
            squashMergeApplied: true, mergeApplications: 1,
            mergedWithoutGreenGate: true,          // the lie
            acceptanceRanGreenBeforeMerge: false,  // ...merged though Layer B never passed
            capRespected: true, stallDetectedAndRecycled: false, noProgressBailed: false,
            worktreeRemoved: true, branchKept: false, diffstatRecorded: true, failureReasonSet: false,
            terminalReason: null, sessionIdsCaptured: true,
            config: { iterationCap: 8, noProgressK: 2, denyWallK: 3, costCapUsd: 1000, stallTimeoutMs: 1000, checkTimeoutMs: 1000 },
        };
        const failed = runInvariants(lie).filter((r) => !r.ok).map((r) => r.name);
        expect(failed).toContain("no-merge-on-red");
        expect(failed).toContain("acceptance-gate-mandatory");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const broken = { unit: "runTaskLoop" } as unknown as Snapshot;
        const results = runInvariants(broken);
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });

    it("sanity: the declared invariant set is what we evaluated", async () => {
        const names = runInvariants(await runScenario({ script: [{}] })).map((r) => r.name).sort();
        expect(names).toEqual(INVARIANTS.map((i) => i.name).sort());
    });
});

describe("verify/runner: the CI matrix over every fixture", () => {
    it.each(FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS (observed and right)", async (_id, fixture) => {
        const result = await runFixture(fixture);
        expect<Verdict>(result.verdict).toBe("PASS");
    });

    it("every unit declares at least one probe (no all-happy-path replay)", () => {
        expect(FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it("runAll reports a verdict for every fixture and none are BLOCKED", async () => {
        const results = await runAll();
        expect(results).toHaveLength(FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});

describe("verify/probes: the off-happy-path bounds actually fire", () => {
    it("cap-reached stops at exactly the cap, with no merge", async () => {
        const s = await runScenario({ config: { iterationCap: 2, noProgressK: 99 }, script: [{ checkGreen: false }, { checkGreen: false }] });
        expect(s.finalStatus).toBe("needs-human");
        expect(s.iterationsRun).toBe(2);
        expect(s.squashMergeApplied).toBe(false);
        expect(s.terminalReason).toContain("iteration cap");
    });

    it("no-progress-breaker bails when the commit-sha stops moving", async () => {
        const s = await runScenario({ config: { noProgressK: 2 }, script: [{ checkGreen: false, newCommit: false }, { checkGreen: false, newCommit: false }] });
        expect(s.noProgressBailed).toBe(true);
    });

    it("a stall is detected and recycled, not left hanging", async () => {
        const s = await runScenario({ script: [{ stalled: true }, {}] });
        expect(s.stallDetectedAndRecycled).toBe(true);
        expect(s.finalStatus).toBe("merged");
    });

    it("empty acceptance is flagged needs-human before any iteration runs", async () => {
        const s = await runScenario({ acceptance: [] });
        expect(s.finalStatus).toBe("needs-human");
        expect(s.iterationsRun).toBe(0);
    });
});
