// tests/verify/reconcile/surface.ts
// The M6 ① verify SURFACE. Drives the REAL boot-reconcile planner over hand-built (tasks, gitState)
// fixtures and distils a flat recording the invariants read. Because the planner is a pure function,
// the "real unit" here is reconcile() itself — no scheduler/loop needed. Complementary to, and separate
// from, the untouched M2 (tests/verify/), M3 (snapshot/), M4 (scheduler/) and M5 (dropin/) slices.
//
// Non-circularity: each scenario DECLARES its ground-truth expectations (which running tasks must be
// re-driven, which worktrees must/must-not be pruned) independently of the planner. The invariants then
// compare the ACTIONS under test — the real plan for positive fixtures, a hand-crafted broken list for
// probes — against those declared expectations. So a probe with a wrong action list is genuinely caught.
import { reconcile, type GitState, type ReconcileAction } from "../../../src/main/engine/reconcile";
import type { Task, TaskStatus } from "../../../src/shared/types";

// The scenario controls BOTH the gitState paths and the expectation paths, so exact-string comparison is
// enough here (the planner's own slash-normalisation is unit-tested separately in tests/engine/).
export const wt = (name: string): string => `/repo/.helm/worktrees/${name}`;

export const mkTask = (id: string, status: TaskStatus, over: Partial<Task> = {}): Task => ({
    id, projectId: "p1", title: id, intent: "", acceptance: ["x"], status, scopeHint: null, dependsOn: [], planId: null,
    branchName: `ralph/task-${id}`, worktreePath: wt(`ralph-task-${id}`), diffstat: null, failureReason: null,
    createdAt: 0, updatedAt: 0, ...over,
});

// Ground-truth expectations the scenario author declares (independent of the planner).
export interface Expectations {
    runningTaskIds: string[];      // each MUST get exactly one task action (requeue|rebuild|to-needs-human)
    mustPrunePaths: string[];      // orphans + terminal-owned leftovers → MUST appear in the prune set
    mustNotPrunePaths: string[];   // retaining-status (running|queued|handed-off|needs-human) worktrees → NEVER pruned
    terminalOwnedPaths: string[];  // leftover worktrees owned by a terminal (merged|abandoned) task → MUST be pruned
}

export interface Scenario { tasks: Task[]; git: GitState; expectations: Expectations }

// The flat recording the invariants read: the declared ground truth + what the actions actually did.
export interface ReconcileRecording {
    unit: "reconcile";
    runningTaskIds: string[];
    mustPrunePaths: string[];
    mustNotPrunePaths: string[];
    terminalOwnedPaths: string[];
    taskActionCountById: Record<string, number>; // requeue|rebuild|to-needs-human count per taskId
    prunedPaths: string[];                        // paths in prune-worktree actions
}

// Distil a recording from the declared expectations + a list of actions (real plan, or hand-crafted probe).
export function distill(expectations: Expectations, actions: ReconcileAction[]): ReconcileRecording {
    const taskActionCountById: Record<string, number> = {};
    for (const id of expectations.runningTaskIds) taskActionCountById[id] = 0; // seed 0 so a MISSING action reads as 0
    const prunedPaths: string[] = [];
    for (const a of actions) {
        if (a.type === "requeue" || a.type === "rebuild" || a.type === "to-needs-human") {
            taskActionCountById[a.taskId] = (taskActionCountById[a.taskId] ?? 0) + 1;
        } else if (a.type === "prune-worktree") {
            prunedPaths.push(a.path);
        }
    }
    return { unit: "reconcile", ...expectations, taskActionCountById, prunedPaths };
}

// Positive: drive the REAL planner over the scenario, distil with the scenario's declared expectations.
export function runScenario(scenario: Scenario): ReconcileRecording {
    return distill(scenario.expectations, reconcile(scenario.tasks, scenario.git));
}

// ── Scenarios ────────────────────────────────────────────────────────────────────────────────────
// The comprehensive happy scenario: a crashed running task (intact worktree) → requeue; a helm/merge-*
// throwaway → prune; a handed-off + a needs-human worktree → RETAINED (never pruned — the M5↔M6 rule).
export function happyScenario(): Scenario {
    const running = mkTask("run-intact", "running");
    const handed = mkTask("handed", "handed-off");
    const needs = mkTask("needs", "needs-human");
    const git: GitState = {
        worktrees: [
            { path: running.worktreePath!, branch: "ralph/task-run-intact" },
            { path: handed.worktreePath!, branch: "ralph/task-handed" },
            { path: needs.worktreePath!, branch: "ralph/task-needs" },
            { path: wt("helm-merge-x"), branch: "helm/merge-x" }, // crash-orphaned merge throwaway
        ],
        branches: ["ralph/task-run-intact", "ralph/task-handed", "ralph/task-needs", "helm/merge-x", "integration/ralph"],
    };
    return {
        tasks: [running, handed, needs], git,
        expectations: {
            runningTaskIds: ["run-intact"],
            mustPrunePaths: [wt("helm-merge-x")],
            mustNotPrunePaths: [running.worktreePath!, handed.worktreePath!, needs.worktreePath!],
            terminalOwnedPaths: [],
        },
    };
}

// Coverage: a running task whose worktree is gone but branch alive → rebuild; one whose worktree AND
// branch are gone → to-needs-human. (Exactly-one-action holds for both; the action TYPES are asserted
// directly in the CI matrix test.)
export function rebuildAndNeedsHumanScenario(): Scenario {
    const rebuildTask = mkTask("run-rebuild", "running");
    const lostTask = mkTask("run-lost", "running");
    const git: GitState = {
        worktrees: [], // both worktrees gone
        branches: ["ralph/task-run-rebuild", "integration/ralph"], // run-lost's branch is gone too
    };
    return {
        tasks: [rebuildTask, lostTask], git,
        expectations: { runningTaskIds: ["run-rebuild", "run-lost"], mustPrunePaths: [], mustNotPrunePaths: [], terminalOwnedPaths: [] },
    };
}

// A leftover worktree owned only by a terminal (merged) task → pruned (worktree-cleaned-on-terminal).
export function terminalLeftoverScenario(): Scenario {
    const merged = mkTask("merged1", "merged");
    const git: GitState = {
        worktrees: [{ path: merged.worktreePath!, branch: "ralph/task-merged1" }],
        branches: ["ralph/task-merged1", "integration/ralph"],
    };
    return {
        tasks: [merged], git,
        expectations: { runningTaskIds: [], mustPrunePaths: [merged.worktreePath!], mustNotPrunePaths: [], terminalOwnedPaths: [merged.worktreePath!] },
    };
}
