// src/main/engine/handback.ts
// The two engine-side hand-back/cleanup actions out of `handed-off` that need no new orchestration:
//   • Verify-&-merge — commit the human's edits, then reuse runMergeStage VERBATIM (rebase-on-tip +
//     re-check in a throwaway worktree); merged → land + remove, needs-human → retain for another drop-in.
//   • Abandon — the worktree reaper the M5 retention change requires: remove the retained worktree +
//     branch and flag abandoned, tolerating an already-reaped worktree.
//
// Pure DI (no Electron, no direct git) so they unit-test with fakes. The mutex wrap + fire-and-forget
// live in ipc.ts (Task 7): verify-&-merge takes NO concurrency slot (drop-in freed it) — only the
// project's merge mutex, so it can't violate the cap or corrupt integration.
import type { Project, Task, TaskStatus, FailureNote } from "../../shared/types";
import type { MergeStageResult } from "./mergeStage";

export interface HandbackDeps {
    commitAll: (repo: string, message: string) => Promise<void>;
    runMergeStage: (project: Project, task: Task, taskBranch: string) => Promise<MergeStageResult>;
    setStatus: (taskId: string, status: TaskStatus, extra?: { diffstat?: string; failureReason?: string | null; failure?: FailureNote }) => void;
    removeWorktree: (repo: string, path: string, branch: string, keepBranch: boolean) => Promise<void>;
}

// "I finished it — verify & merge" (spec §8). Capture the human's working tree first (commitAll no-ops
// on a clean tree), then run the SAME merge stage the loop's green branch uses. A green re-check lands +
// removes the worktree; a red one keeps the task in needs-human with the worktree retained.
export async function verifyAndMerge(project: Project, task: Task, taskBranch: string, d: HandbackDeps): Promise<MergeStageResult> {
    if (task.worktreePath) await d.commitAll(task.worktreePath, "ralph: handback");
    const r = await d.runMergeStage(project, task, taskBranch);
    if (r.outcome === "merged") {
        // Clear any stale failureReason (this task may have been needs-human before the human dropped in).
        d.setStatus(task.id, "merged", { diffstat: r.diffstat, failureReason: null });
        if (task.worktreePath) await d.removeWorktree(project.repoPath, task.worktreePath, taskBranch, false);
    } else {
        // M17: the merge stage's structured kind rides into the ledger; iterationIndex is null — this
        // failure belongs to the human's hand-back, not to any loop iteration.
        d.setStatus(task.id, "needs-human", { failureReason: r.reason, failure: { kind: r.kind, iterationIndex: null } });
        // Retain the worktree — the human can drop in again (or abandon it).
    }
    return r;
}

// Abandon (spec §12/§14): reap the retained worktree + branch and mark the task abandoned. Tolerant of an
// already-removed worktree (a double-click, or a prior green verify-&-merge) so it never throws.
export async function abandon(project: Project, task: Task, taskBranch: string, d: HandbackDeps): Promise<void> {
    if (task.worktreePath) {
        try {
            await d.removeWorktree(project.repoPath, task.worktreePath, taskBranch, false);
        } catch {
            // Already reaped (worktree gone) — the postcondition (no worktree) still holds; don't fail.
        }
    }
    d.setStatus(task.id, "abandoned", { failureReason: null }); // terminal-success: no stale red reason on the card
}
