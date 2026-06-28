// tests/engine/runTask.test.ts
import { runTaskSinglePass, type RunTaskDeps } from "../../src/main/engine/runTask";
import type { Project, Task } from "../../src/shared/types";

const project: Project = {
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph",
    targetBranch: "main", branchPrefix: "ralph", checkCommand: "npm test", worktreeDir: ".helm/worktrees",
};
const task: Task = {
    id: "abc", projectId: "p1", title: "T", intent: "do", acceptance: ["x"], status: "queued",
    branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0,
};

function deps(overrides: Partial<RunTaskDeps> = {}): { deps: RunTaskDeps; calls: string[] } {
    const calls: string[] = [];
    const base: RunTaskDeps = {
        ensureBranch: async () => { calls.push("ensureBranch"); },
        checkoutBranch: async () => { calls.push("checkoutBranch"); },
        createWorktree: async () => { calls.push("createWorktree"); return "/repo/.helm/worktrees/ralph-task-abc"; },
        removeWorktree: async (_r, _p, _b, keep) => { calls.push(`removeWorktree:${keep}`); },
        spawnAgent: async () => { calls.push("spawn"); return { ok: true, output: "ok", sessionId: null }; },
        commitAll: async () => { calls.push("commitAll"); },
        runCheck: async () => { calls.push("runCheck"); return { green: true, timedOut: false, output: "" }; },
        squashMergeInto: async () => { calls.push("merge"); return { merged: true, conflict: false }; },
        diffStat: async () => "+1 -0",
        setStatus: (_id, s, _extra) => { calls.push(`status:${s}`); },
        addIteration: () => ({ id: "it1" }),
        finishIteration: () => { calls.push("finishIteration"); },
        log: () => {},
        ...overrides,
    };
    return { deps: base, calls };
}

it("happy path: spawn → commit → check green → squash-merge → merged + worktree removed", async () => {
    const { deps: d, calls } = deps();
    const status = await runTaskSinglePass(project, task, d);
    expect(status).toBe("merged");
    expect(calls).toEqual([
        "ensureBranch", "checkoutBranch", "createWorktree", "status:running",
        "spawn", "commitAll", "runCheck", "merge", "status:merged", "finishIteration", "removeWorktree:false",
    ]);
});

it("check fails → needs-human, worktree kept for inspection", async () => {
    const { deps: d, calls } = deps({ runCheck: async () => ({ green: false, timedOut: false, output: "boom" }) });
    const status = await runTaskSinglePass(project, task, d);
    expect(status).toBe("needs-human");
    expect(calls).toContain("status:needs-human");
    expect(calls).toContain("removeWorktree:true");
    expect(calls).not.toContain("merge");
});

it("agent failure → needs-human before the check runs", async () => {
    const { deps: d, calls } = deps({ spawnAgent: async () => ({ ok: false, output: "claude died", sessionId: null }) });
    const status = await runTaskSinglePass(project, task, d);
    expect(status).toBe("needs-human");
    expect(calls).not.toContain("runCheck");
});
