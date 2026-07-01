// src/main/engine/reconcile.ts
// The pure boot-reconcile planner (spec §4 "process death is cheap"). Given a DB+git snapshot it
// decides exactly what boot should do to reconcile the two — with NO side effects. This is the tested
// heart; the thin executor that lists git state, calls this once, and applies the actions with real
// git/DB fns lives at the ipc boot edge (its real effects are covered by manual acceptance).
//
// LEAF MODULE: imports only shared/types (no engine graph), so the verify slice drives the real planner
// with hand-built fixtures.
//
// ⚠️ CONTRACT — the primary repo checkout appears in `git worktree list` and MUST NEVER be pruned. This
// planner has no way to recognise it, so the executor GUARANTEES it by passing only worktrees whose path
// is under `join(repoPath, worktreeDir)`. Never call reconcile() with the primary checkout in GitState.
import { join } from "node:path";
import type { Task, TaskStatus } from "../../shared/types";

export interface WorktreeInfo { path: string; branch: string | null }
// worktrees ALREADY filtered by the executor to those under worktreeDir (see the contract note above).
export interface GitState { worktrees: WorktreeInfo[]; branches: string[] }

export type ReconcileAction =
    | { type: "requeue"; taskId: string }                        // worktree intact → close-out + checkpoint + queued
    | { type: "rebuild"; taskId: string; branch: string }        // worktree gone, branch alive → recreate from branch tip → queued
    | { type: "to-needs-human"; taskId: string; reason: string } // both gone → nothing to resume
    | { type: "prune-worktree"; path: string; branch: string | null };

// Git prints worktree paths with forward slashes even on Windows, while task.worktreePath was built with
// node's join() (backslashes on Windows). Normalise both sides before comparing so the same worktree
// matches regardless of representation (both derive from project.repoPath → same case).
function normPath(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function ownsWorktree(task: Task, wt: WorktreeInfo): boolean {
    return task.worktreePath != null && normPath(task.worktreePath) === normPath(wt.path);
}

// The executor's safety filter: is `worktreePath` under `<repoPath>/<worktreeDir>`? Only worktrees for
// which this holds may be passed to reconcile() — that's how the executor honours the ⚠️ contract above
// (the primary repo checkout and any unrelated worktrees are excluded). The `+ "/"` boundary stops a
// sibling like `.helm/worktrees-evil` from matching `.helm/worktrees`.
export function isUnderWorktreeDir(worktreePath: string, repoPath: string, worktreeDir: string): boolean {
    const root = normPath(join(repoPath, worktreeDir));
    const p = normPath(worktreePath);
    return p === root || p.startsWith(root + "/");
}

// A worktree is legitimately in use — never prune it — while a task in one of these statuses owns it.
// A crashed `running` task being requeued/rebuilt still counts as retaining, so its intact worktree
// survives; `handed-off`/`needs-human` are the M5 drop-in retention lifecycle. Terminal statuses
// (merged | abandoned) do NOT retain — a leftover worktree they own is reaped.
const RETAINING: readonly TaskStatus[] = ["running", "queued", "handed-off", "needs-human"];

export function reconcile(tasks: Task[], git: GitState): ReconcileAction[] {
    const actions: ReconcileAction[] = [];

    // Task actions — only for `running`: every running task at boot is crashed (the in-memory running-set
    // didn't survive the process), so it has no live loop and must be re-driven.
    for (const task of tasks) {
        if (task.status !== "running") continue;
        if (git.worktrees.some((wt) => ownsWorktree(task, wt))) {
            actions.push({ type: "requeue", taskId: task.id });
        } else if (task.branchName != null && git.branches.includes(task.branchName)) {
            // Worktree gone but the branch (and its committed code) survived → recreate from the branch tip.
            actions.push({ type: "rebuild", taskId: task.id, branch: task.branchName });
        } else {
            // Both gone → nothing to resume; surface it for a human rather than silently dropping the task.
            actions.push({ type: "to-needs-human", taskId: task.id, reason: "interrupted by shutdown; worktree and branch both gone" });
        }
    }

    // Prune actions — reap a worktree iff it's a helm throwaway (`helm/merge-*`, `helm/promote-*`) OR no
    // task in a RETAINING status owns its path. A rebuild's branch-recreated worktree doesn't exist in
    // this snapshot, so it's never a prune target — plan once, execute once.
    for (const wt of git.worktrees) {
        const isHelmThrowaway = wt.branch?.startsWith("helm/") ?? false;
        const retained = tasks.some((t) => RETAINING.includes(t.status) && ownsWorktree(t, wt));
        if (isHelmThrowaway || !retained) {
            actions.push({ type: "prune-worktree", path: wt.path, branch: wt.branch });
        }
    }

    return actions;
}
