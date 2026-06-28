// tests/engine/runTask.test.ts
import { runIteration, runTaskLoop, type RunTaskDeps } from "../../src/main/engine/runTask";
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

// ---- runIteration tests — driven by a green-path-default factory ----
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

describe("runTaskLoop — happy path", () => {
    it("merges on a first-pass green and cleans up (worktree gone, branch deleted, diffstat set)", async () => {
        const calls: string[] = [];
        const status = await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, deps({
            removeWorktree: async (_r, _p, _b, keepBranch) => { calls.push(`remove:${keepBranch}`); },
            squashMergeInto: async () => { calls.push("merge"); return { merged: true, conflict: false }; },
            setStatus: (_id, s) => { calls.push(`status:${s}`); },
        }));
        expect(status).toBe("merged");
        expect(calls).toContain("merge");
        expect(calls).toContain("remove:false"); // branch deleted on a clean merge
        expect(calls).toContain("status:merged");
    });

    it("flags needs-human immediately when acceptance is empty, without spawning", async () => {
        let spawned = false;
        const status = await runTaskLoop(project, { ...task, acceptance: [] }, DEFAULT_LOOP_CONFIG, deps({
            spawnAgent: async () => { spawned = true; return { ok: true, output: "", sessionId: "s", stalled: false }; },
        }));
        expect(status).toBe("needs-human");
        expect(spawned).toBe(false);
    });
});

// A scripted set of deps: each iteration consumes the next IterStep; headSha advances unless newCommit:false.
interface IterStep { agentOk?: boolean; stalled?: boolean; checkGreen?: boolean; acceptanceOk?: boolean; newCommit?: boolean; }
function scriptedDeps(steps: IterStep[], over: Partial<RunTaskDeps> = {}) {
    let i = -1;
    let lastSha = "sha-base";
    let headCalls = 0;
    const step = () => steps[Math.min(i, steps.length - 1)] ?? {};
    return deps({
        spawnAgent: async () => { i += 1; const s = step(); const stalled = s.stalled ?? false; const ok = (s.agentOk ?? true) && !stalled; return { ok, output: "o", sessionId: `s${i}`, stalled }; },
        headSha: async () => { if (headCalls++ === 0) return "sha-base"; const s = step(); if ((s.newCommit ?? true)) lastSha = `sha-${i}`; return lastSha; },
        runCheck: async () => { const s = step(); return { green: s.checkGreen ?? true, timedOut: false, output: "c" }; },
        runAcceptance: async () => { const s = step(); return { ok: s.acceptanceOk ?? true, output: "a" }; },
        ...over,
    });
}

describe("runTaskLoop — bounds & retry", () => {
    it("retries a red check and merges once it goes green", async () => {
        let iterations = 0;
        const status = await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, scriptedDeps(
            [{ checkGreen: false }, {}],
            { addIteration: (tid, idx) => { iterations += 1; return { id: `it${idx}` }; } },
        ));
        expect(status).toBe("merged");
        expect(iterations).toBe(2);
    });

    it("stops at the iteration cap and flags needs-human", async () => {
        const cfg = { ...DEFAULT_LOOP_CONFIG, iterationCap: 2, noProgressK: 99 };
        let reason = "";
        const status = await runTaskLoop(project, task, cfg, scriptedDeps(
            [{ checkGreen: false }, { checkGreen: false }],
            { setStatus: (_i, _s, extra) => { if (extra?.failureReason) reason = extra.failureReason; } },
        ));
        expect(status).toBe("needs-human");
        expect(reason).toContain("iteration cap");
    });

    it("bails via the no-progress breaker when the commit-sha stops moving", async () => {
        const cfg = { ...DEFAULT_LOOP_CONFIG, noProgressK: 2 };
        let reason = "";
        const status = await runTaskLoop(project, task, cfg, scriptedDeps(
            [{ checkGreen: false, newCommit: false }, { checkGreen: false, newCommit: false }],
            { setStatus: (_i, _s, extra) => { if (extra?.failureReason) reason = extra.failureReason; } },
        ));
        expect(status).toBe("needs-human");
        expect(reason).toContain("no progress");
    });

    it("recycles a stall (hang) and still merges on a later green", async () => {
        const status = await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, scriptedDeps([{ stalled: true }, {}]));
        expect(status).toBe("merged");
    });

    it("flags needs-human (branch kept) on a merge conflict", async () => {
        let keep: boolean | null = null;
        const status = await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, scriptedDeps([{}], {
            squashMergeInto: async () => ({ merged: false, conflict: true }),
            removeWorktree: async (_r, _p, _b, keepBranch) => { keep = keepBranch; },
        }));
        expect(status).toBe("needs-human");
        expect(keep).toBe(true);
    });
});
