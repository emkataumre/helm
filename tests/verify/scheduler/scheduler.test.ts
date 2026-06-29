// tests/verify/scheduler/scheduler.test.ts
// The M4 verify slice's CI matrix. Positive fixtures drive the REAL scheduler + per-project mutex +
// runMergeStage and distill a cross-task recording; probes are hand-crafted broken recordings (negative
// controls). Asserts the three M4 invariants — at-most-one-merge-in-flight, running-count-within-cap,
// rebase-on-tip-then-recheck — each with a probe that MUST FAIL. Vocabulary from ~/.claude/verification.md.
// Complementary to, and separate from, the untouched M2 (tests/verify/) and M3 (tests/verify/snapshot/) slices.
import { describe, it, expect } from "vitest";
import { runSchedulerFixture, runAll, buildRecording, type Verdict } from "./runner";
import { SCHEDULER_INVARIANTS, runSchedulerInvariants } from "./invariants";
import { SCHEDULER_FIXTURES } from "./fixtures";
import { runScenario, mkProject, type SchedulerRecording } from "./surface";

const failed = (r: SchedulerRecording) => runSchedulerInvariants(r).filter((c) => !c.ok).map((c) => c.name);
const overlap = (a: { enter: number; exit: number }, b: { enter: number; exit: number }) => a.enter < b.exit && b.enter < a.exit;

describe("verify/scheduler: the CI matrix over every fixture", () => {
    it.each(SCHEDULER_FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS (observed and right)", async (_id, fixture) => {
        expect<Verdict>((await runSchedulerFixture(fixture)).verdict).toBe("PASS");
    });

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(SCHEDULER_FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it("runAll reports a verdict for every fixture, all PASS, none BLOCKED", async () => {
        const results = await runAll();
        expect(results).toHaveLength(SCHEDULER_FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});

describe("verify/scheduler: the recording is the real units' behaviour", () => {
    it("two simultaneous green tasks: the mutex serializes their merges (intervals never overlap)", async () => {
        const rec = await runScenario({ projects: [mkProject("p", 2)], tasks: [{ id: "a", projectId: "p", recheckPasses: true }, { id: "b", projectId: "p", recheckPasses: true }] });
        expect(rec.merges).toHaveLength(2);
        expect(overlap(rec.merges[0], rec.merges[1])).toBe(false); // at most one merge in flight
        expect(rec.maxRunningPerProject.p).toBeLessThanOrEqual(2);
        expect(failed(rec)).toEqual([]); // every invariant holds for a real run
    });

    it("five queued under cap 3: peak running stays ≤ 3 and all five advance", async () => {
        const rec = await runScenario({ projects: [mkProject("p", 3)], tasks: ["a", "b", "c", "d", "e"].map((id) => ({ id, projectId: "p", recheckPasses: true })) });
        expect(rec.maxRunningPerProject.p).toBeLessThanOrEqual(3);
        expect(rec.merges.filter((m) => m.advanced)).toHaveLength(5);
        expect(failed(rec)).toEqual([]);
    });

    it("winner-and-loser: the loser's failed re-check does NOT advance integration", async () => {
        const rec = await runScenario({ projects: [mkProject("p", 2)], tasks: [{ id: "win", projectId: "p", recheckPasses: true }, { id: "lose", projectId: "p", recheckPasses: false }] });
        const winner = rec.merges.find((m) => m.taskId === "win")!;
        const loser = rec.merges.find((m) => m.taskId === "lose")!;
        expect(winner.advanced).toBe(true);
        expect(loser.advanced).toBe(false); // only the winner lands
        expect(failed(rec)).toEqual([]);
    });

    it("the evaluated invariant set equals the declared set", async () => {
        const rec = await runScenario({ projects: [mkProject("p", 1)], tasks: [{ id: "a", projectId: "p", recheckPasses: true }] });
        expect(runSchedulerInvariants(rec).map((r) => r.name).sort()).toEqual(SCHEDULER_INVARIANTS.map((i) => i.name).sort());
    });
});

describe("verify/scheduler: negative controls — each broken recording FAILS its named invariant", () => {
    it("overlapping merge intervals FAIL at-most-one-merge-in-flight", () => {
        const rec: SchedulerRecording = {
            unit: "scheduler", caps: { p: 3 }, maxRunningPerProject: { p: 1 },
            merges: [
                { taskId: "a", projectId: "p", enter: 1, exit: 4, recheckPassed: true, recheckRanBeforeAdvance: true, advanced: true },
                { taskId: "b", projectId: "p", enter: 2, exit: 5, recheckPassed: true, recheckRanBeforeAdvance: true, advanced: true },
            ],
        };
        expect(failed(rec)).toContain("at-most-one-merge-in-flight");
    });

    it("running over cap FAILS running-count-within-cap", () => {
        const rec: SchedulerRecording = { unit: "scheduler", caps: { p: 3 }, maxRunningPerProject: { p: 4 }, merges: [] };
        expect(failed(rec)).toContain("running-count-within-cap");
    });

    it("an advance without a passing re-check FAILS rebase-on-tip-then-recheck", () => {
        const rec: SchedulerRecording = {
            unit: "scheduler", caps: { p: 3 }, maxRunningPerProject: { p: 1 },
            merges: [{ taskId: "a", projectId: "p", enter: 1, exit: 2, recheckPassed: false, recheckRanBeforeAdvance: false, advanced: true }],
        };
        expect(failed(rec)).toContain("rebase-on-tip-then-recheck");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = {} as unknown as SchedulerRecording; // accessing .merges/.maxRunningPerProject throws inside predicates
        const results = runSchedulerInvariants(garbage);
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });
});
