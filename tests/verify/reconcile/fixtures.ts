// tests/verify/reconcile/fixtures.ts
// Two kinds of fixture. POSITIVE fixtures drive the REAL reconcile planner over a scenario — every
// invariant must hold. PROBES are hand-crafted BROKEN plans (negative controls) paired with the happy
// scenario's ground-truth expectations: each MUST FAIL db-git-reconciled, proving the harness catches a
// lie and isn't just replaying happy paths.
import type { ReconcileAction } from "../../../src/main/engine/reconcile";
import { distill, runScenario, happyScenario, rebuildAndNeedsHumanScenario, terminalLeftoverScenario, wt, type ReconcileRecording } from "./surface";

export interface PositiveFixture { id: string; probe?: false; run: () => ReconcileRecording }
export interface ProbeFixture { id: string; probe: true; recording: ReconcileRecording; mustFail: string }
export type ReconcileFixture = PositiveFixture | ProbeFixture;

const happyExpect = happyScenario().expectations;
const orphanPrune: ReconcileAction = { type: "prune-worktree", path: wt("helm-merge-x"), branch: "helm/merge-x" };

export const RECONCILE_FIXTURES: ReconcileFixture[] = [
    // ── Positive — the REAL planner over each scenario; every invariant must hold ──────────────────
    { id: "happy-requeue-prune-retain", run: () => runScenario(happyScenario()) },
    { id: "rebuild-and-to-needs-human", run: () => runScenario(rebuildAndNeedsHumanScenario()) },
    { id: "terminal-owned-leftover-pruned", run: () => runScenario(terminalLeftoverScenario()) },

    // ── Probes — hand-crafted BROKEN plans over the happy scenario's ground truth ──────────────────
    // Prunes the handed-off worktree a human is legitimately steering.
    {
        id: "handed-off-pruned", probe: true, mustFail: "db-git-reconciled",
        recording: distill(happyExpect, [
            { type: "requeue", taskId: "run-intact" },
            orphanPrune,
            { type: "prune-worktree", path: wt("ralph-task-handed"), branch: "ralph/task-handed" }, // WRONG
        ]),
    },
    // The stuck running task gets no action at all — it would stay `running` forever with no live loop.
    {
        id: "stuck-running-not-requeued", probe: true, mustFail: "db-git-reconciled",
        recording: distill(happyExpect, [orphanPrune]), // the requeue is MISSING
    },
    // The helm/merge-* orphan is left behind (worktrees accumulate across crashes).
    {
        id: "orphan-not-pruned", probe: true, mustFail: "db-git-reconciled",
        recording: distill(happyExpect, [{ type: "requeue", taskId: "run-intact" }]), // no prune of the orphan
    },
];
