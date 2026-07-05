// tests/engine/reconcile.test.ts
// The pure boot-reconcile planner (M6 ①): from a DB+git snapshot it decides exactly what boot should
// do — no side effects. These are the unit red→green tests; the runtime verify slice (probes + the CI
// matrix) lives in tests/verify/reconcile/.
import { describe, it, expect } from "vitest";
import { reconcile, isUnderWorktreeDir, type GitState, type ReconcileAction } from "../../src/main/engine/reconcile";
import type { Task } from "../../src/shared/types";

function mkTask(over: Partial<Task> = {}): Task {
    return {
        id: "t1", projectId: "p1", title: "T", intent: "", acceptance: ["x"], status: "running",
        scopeHint: null, dependsOn: [], branchName: "ralph/task-t1", worktreePath: "/repo/.helm/worktrees/ralph-task-t1",
        diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0, ...over,
    };
}

describe("reconcile — crashed running tasks", () => {
    it("requeues a crashed running task whose worktree is intact", () => {
        const task = mkTask();
        const git: GitState = {
            worktrees: [{ path: "/repo/.helm/worktrees/ralph-task-t1", branch: "ralph/task-t1" }],
            branches: ["ralph/task-t1"],
        };
        expect(reconcile([task], git)).toContainEqual<ReconcileAction>({ type: "requeue", taskId: "t1" });
    });

    it("rebuilds a running task whose worktree is gone but whose branch is alive", () => {
        const task = mkTask({ worktreePath: "/repo/.helm/worktrees/ralph-task-t1", branchName: "ralph/task-t1" });
        const git: GitState = { worktrees: [], branches: ["ralph/task-t1", "integration/ralph"] };
        expect(reconcile([task], git)).toContainEqual<ReconcileAction>({ type: "rebuild", taskId: "t1", branch: "ralph/task-t1" });
    });

    it("sends a running task to needs-human when both worktree and branch are gone", () => {
        const task = mkTask({ worktreePath: "/repo/.helm/worktrees/ralph-task-t1", branchName: "ralph/task-t1" });
        const git: GitState = { worktrees: [], branches: ["integration/ralph"] };
        const actions = reconcile([task], git);
        const action = actions.find((a) => a.type === "to-needs-human");
        expect(action).toEqual<ReconcileAction>({ type: "to-needs-human", taskId: "t1", reason: expect.stringContaining("worktree and branch") });
    });

    it("gives non-running tasks no task action (each of queued/handed-off/needs-human/merged/abandoned)", () => {
        const statuses = ["queued", "handed-off", "needs-human", "merged", "abandoned"] as const;
        for (const status of statuses) {
            const task = mkTask({ status, worktreePath: null, branchName: "ralph/task-t1" });
            const taskActions = reconcile([task], { worktrees: [], branches: [] }).filter(
                (a) => a.type === "requeue" || a.type === "rebuild" || a.type === "to-needs-human",
            );
            expect(taskActions, `status ${status} should get no task action`).toEqual([]);
        }
    });

    it("emits exactly one task action per running task", () => {
        const running = mkTask({ id: "t1", worktreePath: "/repo/.helm/worktrees/ralph-task-t1", branchName: "ralph/task-t1" });
        const git: GitState = {
            worktrees: [{ path: "/repo/.helm/worktrees/ralph-task-t1", branch: "ralph/task-t1" }],
            branches: ["ralph/task-t1"],
        };
        const taskActions = reconcile([running], git).filter(
            (a) => (a.type === "requeue" || a.type === "rebuild" || a.type === "to-needs-human") && a.taskId === "t1",
        );
        expect(taskActions).toHaveLength(1);
    });
});

describe("isUnderWorktreeDir — the executor's safety filter (only these reach the planner)", () => {
    it("accepts a worktree under <repo>/<worktreeDir>", () => {
        expect(isUnderWorktreeDir("/repo/.helm/worktrees/ralph-task-1", "/repo", ".helm/worktrees")).toBe(true);
    });
    it("rejects the primary repo checkout (the reconcile contract: never prune it)", () => {
        expect(isUnderWorktreeDir("/repo", "/repo", ".helm/worktrees")).toBe(false);
    });
    it("rejects a sibling dir that only shares a prefix (worktrees-evil is not under worktrees)", () => {
        expect(isUnderWorktreeDir("/repo/.helm/worktrees-evil/x", "/repo", ".helm/worktrees")).toBe(false);
    });
    it("matches across slash styles (git forward-slash path vs a backslash repoPath)", () => {
        expect(isUnderWorktreeDir("C:/repo/.helm/worktrees/ralph-task-1", "C:\\repo", ".helm/worktrees")).toBe(true);
    });
});

const prunes = (actions: ReconcileAction[]): string[] =>
    actions.filter((a) => a.type === "prune-worktree").map((a) => (a as { path: string }).path);

describe("reconcile — orphan pruning", () => {
    it("prunes a helm/merge-* throwaway worktree (a crash-orphaned merge)", () => {
        const git: GitState = {
            worktrees: [{ path: "/repo/.helm/worktrees/helm-merge-abc", branch: "helm/merge-abc" }],
            branches: ["helm/merge-abc", "integration/ralph"],
        };
        expect(reconcile([], git)).toContainEqual<ReconcileAction>({ type: "prune-worktree", path: "/repo/.helm/worktrees/helm-merge-abc", branch: "helm/merge-abc" });
    });

    it("prunes a worktree owned by no task (a bare orphan)", () => {
        const git: GitState = {
            worktrees: [{ path: "/repo/.helm/worktrees/ralph-task-gone", branch: "ralph/task-gone" }],
            branches: ["ralph/task-gone"],
        };
        expect(prunes(reconcile([], git))).toContain("/repo/.helm/worktrees/ralph-task-gone");
    });

    it("does NOT prune a handed-off task's worktree (the M5 drop-in retention lifecycle)", () => {
        const task = mkTask({ status: "handed-off", worktreePath: "/repo/.helm/worktrees/ralph-task-t1", branchName: "ralph/task-t1" });
        const git: GitState = {
            worktrees: [{ path: "/repo/.helm/worktrees/ralph-task-t1", branch: "ralph/task-t1" }],
            branches: ["ralph/task-t1"],
        };
        expect(prunes(reconcile([task], git))).not.toContain("/repo/.helm/worktrees/ralph-task-t1");
    });

    it("does NOT prune a needs-human task's worktree (retained for drop-in)", () => {
        const task = mkTask({ status: "needs-human", worktreePath: "/repo/.helm/worktrees/ralph-task-t1", branchName: "ralph/task-t1" });
        const git: GitState = {
            worktrees: [{ path: "/repo/.helm/worktrees/ralph-task-t1", branch: "ralph/task-t1" }],
            branches: ["ralph/task-t1"],
        };
        expect(prunes(reconcile([task], git))).not.toContain("/repo/.helm/worktrees/ralph-task-t1");
    });

    it("does NOT prune the intact worktree of a crashed running task being requeued (running still retains)", () => {
        const task = mkTask({ status: "running", worktreePath: "/repo/.helm/worktrees/ralph-task-t1", branchName: "ralph/task-t1" });
        const git: GitState = {
            worktrees: [{ path: "/repo/.helm/worktrees/ralph-task-t1", branch: "ralph/task-t1" }],
            branches: ["ralph/task-t1"],
        };
        const actions = reconcile([task], git);
        expect(actions).toContainEqual<ReconcileAction>({ type: "requeue", taskId: "t1" });
        expect(prunes(actions)).not.toContain("/repo/.helm/worktrees/ralph-task-t1");
    });

    it("prunes a worktree owned only by a terminal (merged/abandoned) task", () => {
        const merged = mkTask({ id: "m", status: "merged", worktreePath: "/repo/.helm/worktrees/ralph-task-m", branchName: "ralph/task-m" });
        const abandoned = mkTask({ id: "a", status: "abandoned", worktreePath: "/repo/.helm/worktrees/ralph-task-a", branchName: "ralph/task-a" });
        const git: GitState = {
            worktrees: [
                { path: "/repo/.helm/worktrees/ralph-task-m", branch: "ralph/task-m" },
                { path: "/repo/.helm/worktrees/ralph-task-a", branch: "ralph/task-a" },
            ],
            branches: ["ralph/task-m", "ralph/task-a"],
        };
        const pruned = prunes(reconcile([merged, abandoned], git));
        expect(pruned).toContain("/repo/.helm/worktrees/ralph-task-m");
        expect(pruned).toContain("/repo/.helm/worktrees/ralph-task-a");
    });

    it("matches ownership across slash styles: a backslash task path vs git's forward-slash path", () => {
        // task.worktreePath is built with node join() (backslashes on Windows); git prints forward slashes.
        const task = mkTask({ status: "running", worktreePath: "C:\\repo\\.helm\\worktrees\\ralph-task-t1", branchName: "ralph/task-t1" });
        const git: GitState = {
            worktrees: [{ path: "C:/repo/.helm/worktrees/ralph-task-t1", branch: "ralph/task-t1" }],
            branches: ["ralph/task-t1"],
        };
        const actions = reconcile([task], git);
        expect(actions).toContainEqual<ReconcileAction>({ type: "requeue", taskId: "t1" }); // matched → requeue, not rebuild
        expect(prunes(actions)).toEqual([]);                                                // matched → owner retains → no prune
    });
});
