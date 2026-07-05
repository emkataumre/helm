// tests/engine/runTask.test.ts
import { runIteration, runTaskLoop, type RunTaskDeps } from "../../src/main/engine/runTask";
import { DEFAULT_LOOP_CONFIG } from "../../src/main/engine/loopConfig";
import type { Project, Task, TokenTotals } from "../../src/shared/types";

const ZERO_USAGE: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 };

const project: Project = {
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph",
    targetBranch: "main", branchPrefix: "ralph", checkCommand: "npm test", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, model: null, concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr",
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
        mergeStage: async () => ({ outcome: "merged", diffstat: "+1 -0" }),
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
    it("is hang when the agent stalled, and records no resumable sessionId", async () => {
        const o = await runIteration(project, task, ctx, DEFAULT_LOOP_CONFIG, deps({ spawnAgent: async () => ({ ok: false, output: "x", sessionId: "s0", stalled: true, usage: ZERO_USAGE, durationMs: null }) }));
        expect(o.verdict).toBe("hang");
        expect(o.sessionId).toBeNull(); // a stalled/killed turn never persisted → not resumable (drop-in guard)
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
    it("delegates landing to mergeStage on a first-pass green and cleans up (worktree gone, branch deleted, diffstat set)", async () => {
        const calls: string[] = [];
        let diffstatSet: string | undefined;
        const status = await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, deps({
            removeWorktree: async (_r, _p, _b, keepBranch) => { calls.push(`remove:${keepBranch}`); },
            mergeStage: async (_p, _t, branch) => { calls.push(`mergeStage:${branch}`); return { outcome: "merged", diffstat: "+9 -2" }; },
            setStatus: (_id, s, extra) => { calls.push(`status:${s}`); if (extra?.diffstat) diffstatSet = extra.diffstat; },
        }));
        expect(status).toBe("merged");
        expect(calls).toContain("mergeStage:ralph/task-abc"); // the loop passes the task branch
        expect(calls).toContain("remove:false");              // branch deleted on a clean merge
        expect(calls).toContain("status:merged");
        expect(diffstatSet).toBe("+9 -2");                    // the mergeStage diffstat is recorded
    });

    it("does NOT check out the integration branch in the main working tree (engine never touches it)", async () => {
        let checkedOut = false;
        await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, deps({
            checkoutBranch: async () => { checkedOut = true; },
        }));
        expect(checkedOut).toBe(false);
    });

    it("clears a stale failureReason on a green merge (terminal-success is DB-authoritative)", async () => {
        // A task that was needs-human (reason set), then resumed and went green, must not keep the red
        // reason on the merged card. terminate() clears it on every merged/abandoned transition.
        let mergedExtra: { failureReason?: string | null; diffstat?: string } | undefined;
        const status = await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, deps({
            setStatus: (_id, s, extra) => { if (s === "merged") mergedExtra = extra; },
        }));
        expect(status).toBe("merged");
        expect(mergedExtra).toBeDefined();
        expect(mergedExtra?.failureReason).toBeNull();
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
        expect(reason).toContain("last gate: project check failed"); // the terminal reason names the last failing gate
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
        expect(reason).toContain("last gate: project check failed"); // includes why the gate kept failing
    });

    it("recycles a stall (hang) and still merges on a later green", async () => {
        const status = await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, scriptedDeps([{ stalled: true }, {}]));
        expect(status).toBe("merged");
    });

    it("PROBE: a mergeStage needs-human result terminates needs-human (worktree retained) with its reason", async () => {
        let removeCalled = false;
        let reason = "";
        const status = await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, scriptedDeps([{}], {
            mergeStage: async () => ({ outcome: "needs-human", reason: "re-check failed after rebase on integration tip" }),
            removeWorktree: async () => { removeCalled = true; },
            setStatus: (_i, _s, extra) => { if (extra?.failureReason) reason = extra.failureReason; },
        }));
        expect(status).toBe("needs-human");
        expect(removeCalled).toBe(false); // M5: needs-human RETAINS the worktree for drop-in (not removed)
        expect(reason).toContain("re-check failed after rebase on integration tip");
    });
});

// M5: drop-in hard-interrupts the live claude and makes runTaskLoop RETURN so the scheduler frees the
// slot. The loop checks d.signal.aborted at two points (top of the for, and right after the iteration),
// and on abort checkpoint-commits, flips to handed-off, and RETAINS the worktree.
describe("runTaskLoop — drop-in bail → handed-off (M5)", () => {
    it("PROBE: a drop-in mid-iteration bails to handed-off, retains the worktree, checkpoints, emits status", async () => {
        const controller = new AbortController();
        const commits: string[] = [];
        let removeCalled = false;
        const statusEvents: string[] = [];
        const status = await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, deps({
            signal: controller.signal,
            // The drop-in killed the live session: spawnAgent aborts the controller, then resolves not-ok.
            spawnAgent: async () => { controller.abort(); return { ok: false, output: "killed", sessionId: "s-killed", stalled: false, usage: ZERO_USAGE, durationMs: null }; },
            commitAll: async (_r, msg) => { commits.push(msg); },
            removeWorktree: async () => { removeCalled = true; },
            setStatus: () => {},
            emit: (e) => { if (e.type === "status") statusEvents.push(e.status); },
        }));
        expect(status).toBe("handed-off");
        expect(removeCalled).toBe(false);                       // worktree retained for drop-in
        expect(commits).toContain("ralph: drop-in checkpoint"); // checkpoint at the entry boundary
        expect(statusEvents).toContain("handed-off");
    });

    it("does NOT record a killed iteration's sessionId — its turn never persisted, so nothing is resumable", async () => {
        const controller = new AbortController();
        let finishedSession: string | null | undefined = "unset";
        await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, deps({
            signal: controller.signal,
            spawnAgent: async () => { controller.abort(); return { ok: false, output: "killed", sessionId: "s-killed", stalled: false, usage: ZERO_USAGE, durationMs: null }; },
            finishIteration: (_id, patch) => { finishedSession = patch.sessionId; },
        }));
        expect(finishedSession).toBeNull(); // the killed session is unpersisted → drop-in must not --resume it
    });

    it("DOES record a COMPLETED iteration's sessionId — a persisted session IS resumable", async () => {
        let finishedSession: string | null | undefined = "unset";
        await runTaskLoop(project, task, { ...DEFAULT_LOOP_CONFIG, iterationCap: 1, noProgressK: 99 }, deps({
            // agent ok (turn completed → claude persisted <id>.jsonl) but check red → the loop keeps the session.
            spawnAgent: async () => ({ ok: true, output: "ok", sessionId: "s-done", stalled: false, usage: ZERO_USAGE, durationMs: null }),
            runCheck: async () => ({ green: false, timedOut: false, output: "red" }),
            finishIteration: (_id, patch) => { finishedSession = patch.sessionId; },
        }));
        expect(finishedSession).toBe("s-done"); // a completed turn's session is resumable (Drop-in enabled)
    });

    it("PROBE: a signal already aborted at loop entry hands off at the top of the for, without spawning", async () => {
        const controller = new AbortController();
        controller.abort();
        let spawned = false;
        const status = await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, deps({
            signal: controller.signal,
            spawnAgent: async () => { spawned = true; return { ok: true, output: "ok", sessionId: "s", stalled: false, usage: ZERO_USAGE, durationMs: null }; },
        }));
        expect(status).toBe("handed-off");
        expect(spawned).toBe(false); // the top-of-loop guard bailed before any spawn
    });

    it("a fresh (non-resumed) run numbers iterations 0,1,2… (the split counter is byte-identical at startIndex=0)", async () => {
        const indices: number[] = [];
        const cfg = { ...DEFAULT_LOOP_CONFIG, iterationCap: 3, noProgressK: 99 };
        await runTaskLoop(project, task, cfg, scriptedDeps(
            [{ checkGreen: false }, { checkGreen: false }, { checkGreen: false }],
            { addIteration: (_tid, idx) => { indices.push(idx); return { id: `it${idx}` }; } },
        ));
        expect(indices).toEqual([0, 1, 2]);
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

    it("surfaces the setup-failure reason (worktree retained for drop-in)", async () => {
        let reason = "";
        let removeCalled = false;
        await runTaskLoop(withSetup, task, DEFAULT_LOOP_CONFIG, deps({
            runSetup: async () => ({ ok: false, output: "boom" }),
            setStatus: (_i, _s, extra) => { if (extra?.failureReason) reason = extra.failureReason; },
            removeWorktree: async () => { removeCalled = true; },
        }));
        expect(reason).toContain("setup command failed");
        expect(removeCalled).toBe(false); // M5: needs-human retains its worktree
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

// M5: Resume loop re-enters an existing handed-off worktree without re-cloning — reuse the worktree,
// branch, .ralph files and installed deps; fresh iteration budget; the DB iteration index continues.
describe("runTaskLoop — resume mode (M5)", () => {
    const resume = { worktreePath: "/existing/wt", branch: "ralph/task-abc", startIndex: 3 };

    it("reuses the worktree: skips ensureBranch/createWorktree/writeRalphFiles/runSetup and runs in the retained worktree", async () => {
        const calls: string[] = [];
        let usedWorktree = "";
        await runTaskLoop({ ...project, setupCommand: "npm ci" }, task, DEFAULT_LOOP_CONFIG, deps({
            ensureBranch: async () => { calls.push("ensureBranch"); },
            createWorktree: async () => { calls.push("createWorktree"); return "/new/wt"; },
            writeRalphFiles: () => { calls.push("writeRalphFiles"); },
            runSetup: async () => { calls.push("runSetup"); return { ok: true, output: "" }; },
            spawnAgent: async (wt) => { usedWorktree = wt; return { ok: true, output: "ok", sessionId: "s", stalled: false, usage: ZERO_USAGE, durationMs: null }; },
        }), resume);
        expect(calls).toEqual([]);                    // no clone/setup steps ran on resume
        expect(usedWorktree).toBe("/existing/wt");    // the iteration ran in the retained worktree
    });

    it("flips queued → running with the retained branch + worktree", async () => {
        const statusCalls: Array<{ status: string; extra?: { branchName?: string; worktreePath?: string } }> = [];
        await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, deps({
            setStatus: (_id, status, extra) => statusCalls.push({ status, extra }),
        }), resume);
        const running = statusCalls.find((c) => c.status === "running");
        expect(running?.extra).toMatchObject({ branchName: "ralph/task-abc", worktreePath: "/existing/wt" });
    });

    it("numbers iterations from startIndex (the DB index continues across the handback)", async () => {
        const indices: number[] = [];
        const cfg = { ...DEFAULT_LOOP_CONFIG, iterationCap: 3, noProgressK: 99 };
        await runTaskLoop(project, task, cfg, scriptedDeps(
            [{ checkGreen: false }, { checkGreen: false }, { checkGreen: false }],
            { addIteration: (_t, idx) => { indices.push(idx); return { id: `it${idx}` }; } },
        ), { worktreePath: "/wt", branch: "ralph/task-abc", startIndex: 3 });
        expect(indices).toEqual([3, 4, 5]); // continues from the 3 prior iterations
    });

    it("gets a FRESH budget: runs up to iterationCap MORE iterations regardless of prior count", async () => {
        let iterations = 0;
        const cfg = { ...DEFAULT_LOOP_CONFIG, iterationCap: 2, noProgressK: 99 };
        const status = await runTaskLoop(project, task, cfg, scriptedDeps(
            [{ checkGreen: false }, { checkGreen: false }],
            { addIteration: (_t, idx) => { iterations += 1; return { id: `it${idx}` }; } },
        ), { worktreePath: "/wt", branch: "ralph/task-abc", startIndex: 10 });
        expect(iterations).toBe(2);          // a fresh cap of 2, even though it resumed at index 10
        expect(status).toBe("needs-human");  // cap reached again, budget exhausted
    });
});

// M4 hardening: the worktree-setup git calls run BEFORE the task flips to "running". A failure here
// (e.g. a malformed repoPath → "git ... cannot change to ' C:\\...'") must NOT throw an unhandled
// rejection and leave the task "queued" — the scheduler would re-select the doomed task forever.
// It must land needs-human (visible, leaves the queue) with the git error as the reason.
describe("runTaskLoop — pre-run git failure (M4 hardening)", () => {
    it("PROBE: a failing createWorktree → needs-human (resolves, never throws), agent never spawned, git error in reason", async () => {
        let spawned = false;
        let statusSet = "";
        let reason = "";
        const status = await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, deps({
            createWorktree: async () => { throw new Error("Helm: git worktree add failed: cannot change to ' /repo': Invalid argument"); },
            spawnAgent: async () => { spawned = true; return { ok: true, output: "", sessionId: "s", stalled: false, usage: ZERO_USAGE, durationMs: null }; },
            setStatus: (_id, s, extra) => { statusSet = s; if (extra?.failureReason) reason = extra.failureReason; },
        }));
        expect(status).toBe("needs-human");           // resolves — does NOT reject/throw (no spin, no unhandled rejection)
        expect(spawned).toBe(false);                   // never reached an iteration
        expect(statusSet).toBe("needs-human");         // task left the "queued"/"running" churn
        expect(reason).toContain("cannot change to");  // the git error is surfaced
    });

    it("a failing ensureBranch also lands needs-human without throwing", async () => {
        const status = await runTaskLoop(project, task, DEFAULT_LOOP_CONFIG, deps({
            ensureBranch: async () => { throw new Error("Helm: git branch failed"); },
        }));
        expect(status).toBe("needs-human");
    });
});
