// tests/verify/reconcile/reconcile.test.ts
// The M6 ① verify slice's CI matrix. Positive fixtures drive the REAL reconcile planner over hand-built
// (tasks, gitState) scenarios and distil a recording; probes are hand-crafted broken plans (negative
// controls). Asserts the two M6 ① invariants — db-git-reconciled and worktree-cleaned-on-terminal —
// with the three roadmap MUST-FAIL probes (handed-off-pruned · stuck-running-not-requeued ·
// orphan-not-pruned). Vocabulary from ~/.claude/verification.md. Complementary to, and separate from,
// the untouched M2/M3/M4/M5 slices. Runs headless under `npm run check`, zero production footprint.
import { describe, it, expect } from "vitest";
import { reconcile } from "../../../src/main/engine/reconcile";
import { runReconcileFixture, runAll, type Verdict } from "./runner";
import { RECONCILE_INVARIANTS, runReconcileInvariants } from "./invariants";
import { RECONCILE_FIXTURES } from "./fixtures";
import { runScenario, happyScenario, rebuildAndNeedsHumanScenario, terminalLeftoverScenario, type ReconcileRecording } from "./surface";

const failed = (r: ReconcileRecording) => runReconcileInvariants(r).filter((c) => !c.ok).map((c) => c.name);

describe("verify/reconcile: the CI matrix over every fixture", () => {
    it.each(RECONCILE_FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS (observed and right)", (_id, fixture) => {
        expect<Verdict>(runReconcileFixture(fixture).verdict).toBe("PASS");
    });

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(RECONCILE_FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it("declares the three roadmap probes (handed-off-pruned · stuck-running-not-requeued · orphan-not-pruned)", () => {
        const probeIds = RECONCILE_FIXTURES.filter((f) => f.probe).map((f) => f.id);
        expect(probeIds).toEqual(expect.arrayContaining(["handed-off-pruned", "stuck-running-not-requeued", "orphan-not-pruned"]));
    });

    it("runAll reports a verdict for every fixture, all PASS, none BLOCKED", () => {
        const results = runAll();
        expect(results).toHaveLength(RECONCILE_FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});

describe("verify/reconcile: the recording is the real planner's behaviour", () => {
    it("happy scenario: requeue the crashed running task, prune the throwaway, retain handed-off/needs-human", () => {
        const rec = runScenario(happyScenario());
        expect(rec.taskActionCountById["run-intact"]).toBe(1);
        expect(rec.prunedPaths).toContain("/repo/.helm/worktrees/helm-merge-x");
        expect(rec.prunedPaths).not.toContain("/repo/.helm/worktrees/ralph-task-handed");
        expect(rec.prunedPaths).not.toContain("/repo/.helm/worktrees/ralph-task-needs");
        expect(failed(rec)).toEqual([]);
    });

    it("rebuild vs to-needs-human: worktree-gone/branch-alive → rebuild; both-gone → to-needs-human", () => {
        const scenario = rebuildAndNeedsHumanScenario();
        const actions = reconcile(scenario.tasks, scenario.git);
        expect(actions).toContainEqual({ type: "rebuild", taskId: "run-rebuild", branch: "ralph/task-run-rebuild" });
        expect(actions.find((a) => a.type === "to-needs-human" && a.taskId === "run-lost")).toBeDefined();
        expect(failed(runScenario(scenario))).toEqual([]);
    });

    it("a merged-owned leftover worktree is pruned (worktree-cleaned-on-terminal)", () => {
        const rec = runScenario(terminalLeftoverScenario());
        expect(rec.prunedPaths).toContain("/repo/.helm/worktrees/ralph-task-merged1");
        expect(failed(rec)).toEqual([]);
    });

    it("the evaluated invariant set equals the declared set", () => {
        const rec = runScenario(happyScenario());
        expect(runReconcileInvariants(rec).map((r) => r.name).sort()).toEqual(RECONCILE_INVARIANTS.map((i) => i.name).sort());
    });
});

describe("verify/reconcile: negative controls — each broken plan FAILS db-git-reconciled", () => {
    it("pruning a handed-off worktree FAILS db-git-reconciled", () => {
        const fx = RECONCILE_FIXTURES.find((f) => f.id === "handed-off-pruned");
        expect(fx?.probe && failed(fx.recording)).toContain("db-git-reconciled");
    });
    it("leaving a stuck running task un-requeued FAILS db-git-reconciled", () => {
        const fx = RECONCILE_FIXTURES.find((f) => f.id === "stuck-running-not-requeued");
        expect(fx?.probe && failed(fx.recording)).toContain("db-git-reconciled");
    });
    it("leaving a helm/merge-* orphan unpruned FAILS db-git-reconciled", () => {
        const fx = RECONCILE_FIXTURES.find((f) => f.id === "orphan-not-pruned");
        expect(fx?.probe && failed(fx.recording)).toContain("db-git-reconciled");
    });
    it("a leftover terminal-owned worktree left unpruned FAILS worktree-cleaned-on-terminal", () => {
        const scenario = terminalLeftoverScenario();
        // Hand-craft a plan that skips the prune → the terminal-cleanup invariant must catch it.
        const broken: ReconcileRecording = { ...runScenario(scenario), prunedPaths: [] };
        expect(failed(broken)).toContain("worktree-cleaned-on-terminal");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = null as unknown as ReconcileRecording; // property access throws inside predicates
        const results = runReconcileInvariants(garbage);
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });
});
