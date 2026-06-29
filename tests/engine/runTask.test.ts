// tests/engine/runTask.test.ts
import { runIteration, runTaskLoop, type RunTaskDeps } from "../../src/main/engine/runTask";
import { DEFAULT_LOOP_CONFIG } from "../../src/main/engine/loopConfig";
import type { Project, Task, TokenTotals } from "../../src/shared/types";

const ZERO_USAGE: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 };

const project: Project = {
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph",
    targetBranch: "main", branchPrefix: "ralph", checkCommand: "npm test", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, model: null,
};
const task: Task = {
    id: "abc", projectId: "p1", title: "T", intent: "do", acceptance: ["x"], status: "queued", scopeHint: null,
    branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0,
};

// ---- runIteration tests — driven by a green-path-default factory ----
function deps(over: Partial<RunTaskDeps> = {}): RunTaskDeps {
    return {
        ensureBranch: async () => {}, checkoutBranch: async () => {},
        createWorktree: async () => "/wt", removeWorktree: async () => {},
        ensureRalphExcluded: () => {}, writeRalphFiles: () => {},
        runSetup: async () => ({ ok: true, output: "" }),
        spawnAgent: async () => ({ ok: true, output: "ok", sessionId: "s0", stalled: false, usage: ZERO_USAGE, durationMs: null }),
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
        const o = await runIteration(project, task, ctx, DEFAULT_LOOP_CONFIG, deps({ spawnAgent: async () => ({ ok: false, output: "x", sessionId: "s0", stalled: true, usage: ZERO_USAGE, durationMs: null }) }));
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
            spawnAgent: async () => { spawned = true; return { ok: true, output: "", sessionId: "s", stalled: false, usage: ZERO_USAGE, durationMs: null }; },
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
        spawnAgent: async () => { i += 1; const s = step(); const stalled = s.stalled ?? false; const ok = (s.agentOk ?? true) && !stalled; return { ok, output: "o", sessionId: `s${i}`, stalled, usage: ZERO_USAGE, durationMs: null }; },
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

describe("runTaskLoop — tokens + snapshot events (M3)", () => {
    const withUsage = (usage: TokenTotals, durationMs: number | null) =>
        deps({ spawnAgent: async () => ({ ok: true, output: "ok", sessionId: "s0", stalled: false, usage, durationMs }) });

    it("surfaces the agent's usage + duration on the iteration outcome", async () => {
        const usage: TokenTotals = { input: 10, output: 5, cacheRead: 1, cacheCreation: 2, costUsd: 0.1 };
        const o = await runIteration(project, task, ctx, DEFAULT_LOOP_CONFIG, withUsage(usage, 1234));
        expect(o.usage).toEqual(usage);
        expect(o.durationMs).toBe(1234);
    });

    it("passes the iteration's tokens + duration to finishIteration", async () => {
        const usage: TokenTotals = { input: 10, output: 5, cacheRead: 1, cacheCreation: 2, costUsd: 0.1 };
        let patch: Record<string, unknown> | undefined;
        await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, deps({
            spawnAgent: async () => ({ ok: true, output: "ok", sessionId: "s0", stalled: false, usage, durationMs: 1234 }),
            finishIteration: (_id, p) => { patch = p as unknown as Record<string, unknown>; },
        }));
        expect(patch).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheCreationTokens: 2, costUsd: 0.1, durationMs: 1234 });
    });

    it("emits the snapshot event sequence for a green first pass", async () => {
        const types: string[] = [];
        await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, deps({ emit: (e) => types.push(e.type) }));
        expect(types).toEqual(["iteration-start", "gate", "gate", "iteration-end", "status"]);
    });

    it("emits the event sequence across a red-then-green retry", async () => {
        const types: string[] = [];
        await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, scriptedDeps([{ checkGreen: false }, {}], { emit: (e) => types.push(e.type) }));
        expect(types).toEqual(["iteration-start", "gate", "iteration-end", "iteration-start", "gate", "gate", "iteration-end", "status"]);
    });

    it("the terminal status event carries the failure reason", async () => {
        const statusEvents: Array<{ status: string; terminalReason?: string }> = [];
        await runTaskLoop(project, { ...task, acceptance: [] }, DEFAULT_LOOP_CONFIG, deps({
            emit: (e) => { if (e.type === "status") statusEvents.push({ status: e.status, terminalReason: e.terminalReason }); },
        }));
        expect(statusEvents).toHaveLength(1);
        expect(statusEvents[0].status).toBe("needs-human");
        expect(statusEvents[0].terminalReason).toContain("acceptance");
    });
});

describe("runTaskLoop — setupCommand (M3)", () => {
    const withSetup: Project = { ...project, setupCommand: "npm ci" };

    it("runs setup before the first agent spawn when setupCommand is set", async () => {
        const calls: string[] = [];
        await runTaskLoop(withSetup, task, DEFAULT_LOOP_CONFIG, deps({
            runSetup: async () => { calls.push("setup"); return { ok: true, output: "" }; },
            spawnAgent: async () => { calls.push("spawn"); return { ok: true, output: "ok", sessionId: "s", stalled: false, usage: ZERO_USAGE, durationMs: null }; },
        }));
        expect(calls[0]).toBe("setup");
        expect(calls).toContain("spawn");
    });

    it("PROBE: a setup failure → needs-human and the agent is never spawned", async () => {
        let spawned = false;
        const status = await runTaskLoop(withSetup, task, DEFAULT_LOOP_CONFIG, deps({
            runSetup: async () => ({ ok: false, output: "npm ci exploded" }),
            spawnAgent: async () => { spawned = true; return { ok: true, output: "", sessionId: "s", stalled: false, usage: ZERO_USAGE, durationMs: null }; },
        }));
        expect(status).toBe("needs-human");
        expect(spawned).toBe(false);
    });

    it("surfaces the setup-failure reason (branch kept for drop-in)", async () => {
        let reason = "";
        let keep: boolean | null = null;
        await runTaskLoop(withSetup, task, DEFAULT_LOOP_CONFIG, deps({
            runSetup: async () => ({ ok: false, output: "boom" }),
            setStatus: (_i, _s, extra) => { if (extra?.failureReason) reason = extra.failureReason; },
            removeWorktree: async (_r, _p, _b, keepBranch) => { keep = keepBranch; },
        }));
        expect(reason).toContain("setup command failed");
        expect(keep).toBe(true);
    });

    it("NULL setupCommand → setup is skipped and the loop proceeds to merge", async () => {
        let setupCalled = false;
        const status = await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, deps({
            runSetup: async () => { setupCalled = true; return { ok: true, output: "" }; },
        }));
        expect(setupCalled).toBe(false);
        expect(status).toBe("merged");
    });
});
