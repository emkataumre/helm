// tests/engine/runTask.test.ts
import { runTaskSinglePass, runIteration, type RunTaskDeps } from "../../src/main/engine/runTask";
import { DEFAULT_LOOP_CONFIG } from "../../src/main/engine/loopConfig";
import type { Project, Task } from "../../src/shared/types";

const project: Project = {
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph",
    targetBranch: "main", branchPrefix: "ralph", checkCommand: "npm test", worktreeDir: ".helm/worktrees",
};
const task: Task = {
    id: "abc", projectId: "p1", title: "T", intent: "do", acceptance: ["x"], status: "queued",
    branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0,
};

// ---- single-pass tests (retired in Task 13) — driven by a recording factory ----
function spDeps(overrides: Partial<RunTaskDeps> = {}): { deps: RunTaskDeps; calls: string[] } {
    const calls: string[] = [];
    const base: RunTaskDeps = {
        ensureBranch: async () => { calls.push("ensureBranch"); },
        checkoutBranch: async () => { calls.push("checkoutBranch"); },
        createWorktree: async () => { calls.push("createWorktree"); return "/repo/.helm/worktrees/ralph-task-abc"; },
        removeWorktree: async (_r, _p, _b, keep) => { calls.push(`removeWorktree:${keep}`); },
        ensureRalphExcluded: () => {},
        writeRalphFiles: () => {},
        spawnAgent: async () => { calls.push("spawn"); return { ok: true, output: "ok", sessionId: null, stalled: false }; },
        commitAll: async () => { calls.push("commitAll"); },
        headSha: async () => "sha",
        runCheck: async () => { calls.push("runCheck"); return { green: true, timedOut: false, output: "" }; },
        runAcceptance: async () => ({ ok: true, output: "" }),
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
    const { deps: d, calls } = spDeps();
    const status = await runTaskSinglePass(project, task, d);
    expect(status).toBe("merged");
    expect(calls).toEqual([
        "ensureBranch", "checkoutBranch", "createWorktree", "status:running",
        "spawn", "commitAll", "runCheck", "merge", "status:merged", "finishIteration", "removeWorktree:false",
    ]);
});

it("check fails → needs-human, worktree kept for inspection", async () => {
    const { deps: d, calls } = spDeps({ runCheck: async () => ({ green: false, timedOut: false, output: "boom" }) });
    const status = await runTaskSinglePass(project, task, d);
    expect(status).toBe("needs-human");
    expect(calls).toContain("status:needs-human");
    expect(calls).toContain("removeWorktree:true");
    expect(calls).not.toContain("merge");
});

it("agent failure → needs-human before the check runs", async () => {
    const { deps: d, calls } = spDeps({ spawnAgent: async () => ({ ok: false, output: "claude died", sessionId: null, stalled: false }) });
    const status = await runTaskSinglePass(project, task, d);
    expect(status).toBe("needs-human");
    expect(calls).not.toContain("runCheck");
});

// ---- runIteration tests (Task 9) — driven by a green-path-default factory ----
function deps(over: Partial<RunTaskDeps> = {}): RunTaskDeps {
    return {
        ensureBranch: async () => {}, checkoutBranch: async () => {},
        createWorktree: async () => "/wt", removeWorktree: async () => {},
        ensureRalphExcluded: () => {}, writeRalphFiles: () => {},
        spawnAgent: async () => ({ ok: true, output: "ok", sessionId: "s0", stalled: false }),
        commitAll: async () => {}, headSha: async () => "sha1",
        runCheck: async () => ({ green: true, timedOut: false, output: "" }),
        runAcceptance: async () => ({ ok: true, output: "" }),
        squashMergeInto: async () => ({ merged: true, conflict: false }), diffStat: async () => "+1 -0",
        setStatus: () => {}, addIteration: () => ({ id: "it" }), finishIteration: () => {}, log: () => {},
        ...over,
    };
}

const ctx = { index: 0, worktreePath: "/wt", branch: "ralph/task-abc" };

describe("runIteration", () => {
    it("is green when agent ok, check green, acceptance green", async () => {
        const o = await runIteration(project, task, ctx, DEFAULT_LOOP_CONFIG, deps());
        expect(o.verdict).toBe("green");
        expect(o.sessionId).toBe("s0");
    });
    it("is hang when the agent stalled", async () => {
        const o = await runIteration(project, task, ctx, DEFAULT_LOOP_CONFIG, deps({ spawnAgent: async () => ({ ok: false, output: "x", sessionId: "s0", stalled: true }) }));
        expect(o.verdict).toBe("hang");
    });
    it("is failed when the check is red, and never runs acceptance", async () => {
        let ran = false;
        const o = await runIteration(project, task, ctx, DEFAULT_LOOP_CONFIG, deps({
            runCheck: async () => ({ green: false, timedOut: false, output: "boom" }),
            runAcceptance: async () => { ran = true; return { ok: true, output: "" }; },
        }));
        expect(o.verdict).toBe("failed");
        expect(ran).toBe(false);
    });
    it("is failed when acceptance is red, carrying the failing command in gateOutput", async () => {
        const o = await runIteration(project, task, ctx, DEFAULT_LOOP_CONFIG, deps({
            runAcceptance: async () => ({ ok: false, failedCommand: "x", output: "nope" }),
        }));
        expect(o.verdict).toBe("failed");
        expect(o.gateOutput).toContain("x");
    });
});
