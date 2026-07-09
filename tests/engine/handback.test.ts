// tests/engine/handback.test.ts
// The two engine-side hand-back/cleanup actions that need no new orchestration: Abandon (the worktree
// reaper the retention change requires) and Verify-&-merge (pure runMergeStage reuse). Both are DI'd so
// they unit-test with fakes; the mutex wrap + fire-and-forget live in ipc.ts (Task 7).
import { describe, it, expect } from "vitest";
import { verifyAndMerge, abandon, type HandbackDeps } from "../../src/main/engine/handback";
import type { Project, Task } from "../../src/shared/types";

const PROJECT: Project = {
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main",
    branchPrefix: "ralph", checkCommand: "npm test", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, costCapUsd: null, model: null, concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr", jailImage: null, conductorSessionId: null,
};
const TASK: Task = {
    id: "abc", projectId: "p1", title: "T", intent: "do", acceptance: ["x"], status: "handed-off", scopeHint: null, dependsOn: [], planId: null,
    branchName: "ralph/task-abc", worktreePath: "/repo/.helm/worktrees/ralph-task-abc", diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0,
};

function fakeDeps(over: Partial<HandbackDeps> = {}): { deps: HandbackDeps; calls: string[] } {
    const calls: string[] = [];
    const deps: HandbackDeps = {
        commitAll: async (_r, msg) => { calls.push(`commitAll:${msg}`); },
        runMergeStage: async () => { calls.push("runMergeStage"); return { outcome: "merged", diffstat: "+1 -0" }; },
        setStatus: (_id, status, extra) => { calls.push(`setStatus:${status}${extra?.diffstat ? `:${extra.diffstat}` : ""}${extra?.failureReason ? `:${extra.failureReason}` : ""}`); },
        removeWorktree: async () => { calls.push("removeWorktree"); },
        ...over,
    };
    return { deps, calls };
}

describe("verifyAndMerge", () => {
    it("commits the handback BEFORE running the merge stage (the human's edits aren't lost)", async () => {
        const { deps, calls } = fakeDeps();
        await verifyAndMerge(PROJECT, TASK, "ralph/task-abc", deps);
        expect(calls.indexOf("commitAll:ralph: handback")).toBeGreaterThanOrEqual(0);
        expect(calls.indexOf("commitAll:ralph: handback")).toBeLessThan(calls.indexOf("runMergeStage"));
    });

    it("a merged result → setStatus(merged, diffstat) + removeWorktree (clean landing)", async () => {
        const { deps, calls } = fakeDeps({ runMergeStage: async () => ({ outcome: "merged", diffstat: "+9 -2" }) });
        const r = await verifyAndMerge(PROJECT, TASK, "ralph/task-abc", deps);
        expect(r.outcome).toBe("merged");
        expect(calls).toContain("setStatus:merged:+9 -2");
        expect(calls).toContain("removeWorktree");
    });

    it("PROBE: a needs-human result → setStatus(needs-human, reason) + worktree RETAINED (not removed)", async () => {
        const { deps, calls } = fakeDeps({ runMergeStage: async () => ({ outcome: "needs-human", reason: "re-check failed after rebase on integration tip" }) });
        const r = await verifyAndMerge(PROJECT, TASK, "ralph/task-abc", deps);
        expect(r.outcome).toBe("needs-human");
        expect(calls.some((c) => c.startsWith("setStatus:needs-human"))).toBe(true);
        expect(calls).not.toContain("removeWorktree"); // retained for another drop-in
    });
});

// M6 ①: a task that was needs-human (red reason) then verify-&-merged or abandoned must not keep the
// stale reason on its terminal card. Both handback terminal-successes clear failureReason (DB-authoritative).
describe("stale failureReason cleared on any terminal-success (M6)", () => {
    function capturing(over: Partial<HandbackDeps> = {}) {
        const extras: Array<{ status: string; failureReason?: string | null }> = [];
        const { deps } = fakeDeps({ setStatus: (_id, status, extra) => extras.push({ status, failureReason: extra?.failureReason }), ...over });
        return { deps, extras };
    }
    const withReason: Task = { ...TASK, failureReason: "was: re-check failed after rebase on integration tip" };

    it("verify-&-merge → merged clears the stale failureReason", async () => {
        const { deps, extras } = capturing({ runMergeStage: async () => ({ outcome: "merged", diffstat: "+1 -0" }) });
        await verifyAndMerge(PROJECT, withReason, "ralph/task-abc", deps);
        expect(extras.find((e) => e.status === "merged")?.failureReason).toBeNull();
    });

    it("abandon clears the stale failureReason", async () => {
        const { deps, extras } = capturing();
        await abandon(PROJECT, withReason, "ralph/task-abc", deps);
        expect(extras.find((e) => e.status === "abandoned")?.failureReason).toBeNull();
    });
});

describe("abandon (the worktree reaper)", () => {
    it("removes the worktree + branch and sets abandoned", async () => {
        const { deps, calls } = fakeDeps();
        await abandon(PROJECT, TASK, "ralph/task-abc", deps);
        expect(calls).toContain("removeWorktree");
        expect(calls).toContain("setStatus:abandoned");
    });

    it("tolerates an already-reaped worktree (removeWorktree throws) and still sets abandoned", async () => {
        const { deps, calls } = fakeDeps({ removeWorktree: async () => { throw new Error("fatal: not a working tree"); } });
        await abandon(PROJECT, TASK, "ralph/task-abc", deps);
        expect(calls).toContain("setStatus:abandoned");
    });

    it("with no worktree set, just sets abandoned (nothing to reap)", async () => {
        const { deps, calls } = fakeDeps();
        await abandon(PROJECT, { ...TASK, worktreePath: null }, "ralph/task-abc", deps);
        expect(calls).not.toContain("removeWorktree");
        expect(calls).toContain("setStatus:abandoned");
    });
});
