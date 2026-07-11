// src/main/engine/mergeStage.ts
// The isolated, serialized merge — the heart of M4 (and the primitive M6 promotion reuses). Land a
// green task's work on integration SAFELY: squash it onto the FRESH integration tip inside a throwaway
// worktree, re-run check ∧ acceptance THERE, and advance the integration ref only on a green re-check.
// The engine never touches the user's main working tree; integration is checked out nowhere, so the
// advance is an atomic ref update that never holds an unvalidated commit. The throwaway worktree +
// temp branch are removed on EVERY exit (conflict, re-check fail, throw) via try/finally.
//
// Pure DI — no Electron, no direct git — so it unit-tests with fake deps. The real engine fns are
// wired in ipc.ts behind the per-project merge mutex (Task 6). emit feeds the live cockpit snapshot.
import type { Project, Task, SnapshotEvent, FailureKind } from "../../shared/types";

// M17: the needs-human variant carries a structured kind so the failure ledger records WHY without
// parsing the reason string. Tied to the shared FailureKind union via Extract — only the three causes
// this stage can actually produce.
export type MergeStageResult =
    | { outcome: "merged"; diffstat: string }
    | { outcome: "needs-human"; reason: string; kind: Extract<FailureKind, "merge-conflict" | "setup-command" | "recheck-failed"> };

export interface MergeStageDeps {
    createWorktree: (repo: string, from: string, branch: string, worktreeDir: string) => Promise<string>;
    squashMergeInto: (repo: string, taskBranch: string, target: string) => Promise<{ merged: boolean; conflict: boolean }>;
    runSetup: (worktreePath: string, command: string, timeoutMs: number) => Promise<{ ok: boolean; output: string }>;
    runCheck: (worktreePath: string, checkCommand: string, timeoutMs: number) => Promise<{ green: boolean; timedOut: boolean; output: string }>;
    runAcceptance: (worktreePath: string, commands: string[], timeoutMs: number) => Promise<{ ok: boolean; failedCommand?: string; output: string }>;
    removeWorktree: (repo: string, path: string, branch: string, keepBranch: boolean) => Promise<void>;
    diffStat: (repo: string, base: string, branch: string) => Promise<string>;
    advanceBranch: (repo: string, branch: string, toCommitish: string) => Promise<void>;
    headSha: (repoOrWorktree: string) => Promise<string>;
    checkTimeoutMs: number;                  // total timeout for the setup + re-check commands
    emit?: (e: SnapshotEvent) => void;       // feeds the live EngineSnapshot; absent → no-op
}

const TAIL = 1500;
const tail = (s: string): string => (s.length > TAIL ? `…(truncated)\n${s.slice(-TAIL)}` : s);

// Merge-stage gate events are task-level phase markers; index 0 references the task's first iteration,
// which always exists by the time the merge runs (a task only merges after a green iteration), so the
// live feed entry references a real iteration (the activity-feed invariant holds for the live snapshot).
const gate = (label: string): SnapshotEvent => ({ type: "gate", index: 0, label });

export async function runMergeStage(
    project: Project, task: Task, taskBranch: string, d: MergeStageDeps,
): Promise<MergeStageResult> {
    const tempBranch = `helm/merge-${task.id}`;
    let worktreePath: string | null = null;
    d.emit?.(gate("merge: merging"));
    try {
        // Throwaway worktree off the FRESH integration tip, on a temp branch (git worktree add -b).
        worktreePath = await d.createWorktree(project.repoPath, project.integrationBranch, tempBranch, project.worktreeDir);

        // Apply the task's squashed diff onto the fresh tip. A textual conflict → bail, never advance.
        const merge = await d.squashMergeInto(worktreePath, taskBranch, tempBranch);
        if (merge.conflict) return { outcome: "needs-human", reason: "merge conflict", kind: "merge-conflict" };

        // The fresh worktree has no gitignored deps (node_modules &c.) — install them before the
        // re-check or it would spuriously fail. A setup failure here is a config problem, not the task's.
        if (project.setupCommand) {
            const setup = await d.runSetup(worktreePath, project.setupCommand, d.checkTimeoutMs);
            if (!setup.ok) return { outcome: "needs-human", reason: `merge setup failed:\n${tail(setup.output)}`, kind: "setup-command" };
        }

        // The authoritative re-check against the fresh tip — check ∧ acceptance, mirroring the loop's
        // own green definition. Either red means the task's work doesn't compose with the new tip (a
        // silent semantic conflict) → bail to needs-human; integration is NOT advanced.
        d.emit?.(gate("merge re-check: running"));
        const check = await d.runCheck(worktreePath, project.checkCommand, d.checkTimeoutMs);
        const acc = check.green ? await d.runAcceptance(worktreePath, task.acceptance, d.checkTimeoutMs) : null;
        if (!check.green || (acc && !acc.ok)) {
            d.emit?.(gate("merge re-check: failed"));
            // Name the culprit + carry the output tail (like the setup path): a bare fixed string made
            // every re-check failure an on-site forensic job, and hid timeouts entirely — a cold-cache
            // test flake took two incidents to diagnose. The prefix stays stable for existing matchers.
            const detail = !check.green
                ? (check.timedOut ? `check timed out (${d.checkTimeoutMs}ms)` : `check red:\n${tail(check.output)}`)
                : `acceptance red (${acc!.failedCommand ?? "?"}):\n${tail(acc!.output)}`;
            return { outcome: "needs-human", reason: `re-check failed after rebase on integration tip — ${detail}`, kind: "recheck-failed" };
        }
        d.emit?.(gate("merge re-check: passed"));

        // Green re-check → atomically advance integration to the validated temp tip. Size the landing
        // diff BEFORE advancing (integration still points at the old tip), then move the ref.
        const tip = await d.headSha(worktreePath);
        const diffstat = await d.diffStat(project.repoPath, project.integrationBranch, tempBranch);
        await d.advanceBranch(project.repoPath, project.integrationBranch, tip);
        d.emit?.(gate("merge: merged"));
        return { outcome: "merged", diffstat };
    } finally {
        // Cleanup must NEVER wedge the task. By here integration is either already advanced (merged) or we
        // returned needs-human, so a throwaway-removal failure (e.g. Windows long-path on deep node_modules)
        // is cosmetic. Swallow it: a throw in `finally` would override the return and reject the whole stage,
        // which previously stranded the task in "running" with its work already on integration.
        if (worktreePath) {
            try {
                await d.removeWorktree(project.repoPath, worktreePath, tempBranch, false);
            } catch {
                d.emit?.(gate("merge cleanup: skipped (throwaway left behind)"));
            }
        }
    }
}
