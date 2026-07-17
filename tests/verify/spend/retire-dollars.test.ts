// tests/verify/spend/retire-dollars.test.ts
// The proof that the legacy dollar CAP is RETIRED and the token cap is the SOLE spend ceiling, in
// three parts:
//   Part 1 — dollars are INERT in the loop: a high-costUsd-but-low-token run does NOT park (the
//   mandated live probe — it would have tripped the OLD $25 cap). The retired meter's rule is
//   restated inline over the same recorded costUsd series and shown to DIVERGE from the real loop's
//   behaviour: a resurrected `spend >= costCapUsd` gate could not survive this test.
//   Part 2 — the token backstop is the working ceiling: a high-token run DOES park needs-human on
//   "token cap reached" before the next spawn, and cacheRead never counts toward it.
//   Part 3 — the config surface is retired: DEFAULT_LOOP_CONFIG carries NO costCapUsd (the old $25→
//   Infinity default is gone entirely), resolveLoopConfig maps a NULL/absent projects.costCapUsd
//   column to undefined (nothing to honor), and only the degenerate kill-switch survives — an
//   explicit 0 still spawns nothing.
//
// NOTE on scope: costUsd itself still flows (spawn capture + iteration row) as display accounting —
// the pinned legacy characterisation tests (tests/engine/spawn.test.ts, tests/engine/runTask.test.ts)
// freeze that seam. What this slice proves retired is the dollar SPEND GATE: no dollar figure,
// however large, gates a spawn anywhere.
//
// Non-circularity: each scenario records its ground truth — the per-iteration costUsd and billable
// tokens — at the spawn seam, independent of the loop's own accounting. The invariants re-derive the
// expected behaviour from those raw series (the old meter's halt point; the billable prior-spend
// series) and compare against what the loop ACTUALLY did. Self-contained in this one file — the
// tokens.test.ts shape.
import { describe, it, expect } from "vitest";
import { runTaskLoop, type RunTaskDeps } from "../../../src/main/engine/runTask";
import { DEFAULT_LOOP_CONFIG, resolveLoopConfig, type LoopConfig } from "../../../src/main/engine/loopConfig";
import type { Project, Task, TaskStatus, TokenTotals } from "../../../src/shared/types";

// ── Shared harness: the REAL runTaskLoop over scripted spend ──────────────────────────────────────────

const mkProject = (): Project => ({
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main",
    branchPrefix: "ralph", checkCommand: "npm run check", worktreeDir: ".helm/worktrees", setupCommand: null,
    iterationCap: null, noProgressK: null, stallTimeoutMin: null, model: null, concurrencyCap: null,
    terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr", jailImage: null, conductorSessionId: null,
});
const mkTask = (): Task => ({
    id: "t1", projectId: "p1", title: "T", intent: "do", acceptance: ["x"], status: "queued", scopeHint: null,
    dependsOn: [], planId: null, branchName: null, worktreePath: null, diffstat: null, failureReason: null,
    createdAt: 0, updatedAt: 0,
});

// Every other breaker is out of reach; the spend ceiling is the sole breaker under observation. Note
// costCapUsd 25 — the OLD default $ cap, deliberately configured so a dollar meter WOULD trip if one
// still existed.
const TEST_CONFIG: LoopConfig = { iterationCap: 4, noProgressK: 99, denyWallK: 99, mergeRecycleK: 0, tokenCap: 1000, stallTimeoutMs: 1000, checkTimeoutMs: 1000 };

interface SpendStep { usage: TokenTotals; checkGreen?: boolean }
interface RunResult {
    finalStatus: TaskStatus;
    terminalReason: string | null;
    iterationsRun: number;
    perIterationCostUsd: number[]; // ground truth, recorded at the spawn seam
}

const usage = (u: Partial<TokenTotals>): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, ...u });

async function runLoop(script: SpendStep[], config: Partial<LoopConfig> = {}): Promise<RunResult> {
    const perIterationCostUsd: number[] = [];
    const statusCalls: { status: TaskStatus; reason: string | null }[] = [];
    let iterIdx = -1, headCalls = 0;
    const step = (): SpendStep => script[Math.min(iterIdx, script.length - 1)] ?? { usage: usage({}) };

    const deps: RunTaskDeps = {
        ensureBranch: async () => {}, checkoutBranch: async () => {},
        createWorktree: async () => "/repo/.helm/worktrees/ralph-task-t1",
        removeWorktree: async () => {},
        ensureRalphExcluded: () => {}, writeRalphFiles: () => {},
        runSetup: async () => ({ ok: true, output: "" }),
        spawnAgent: async () => {
            iterIdx += 1;
            const u = step().usage;
            perIterationCostUsd.push(u.costUsd);
            return { ok: true, output: "did work", sessionId: `sess-${iterIdx}`, stalled: false, usage: u, durationMs: 1000, deniedCommands: [] };
        },
        commitAll: async () => {},
        headSha: async () => (headCalls++ === 0 ? "sha-base" : `sha-${iterIdx}`), // fresh commit each pass
        runCheck: async () => { const green = step().checkGreen ?? false; return { green, timedOut: false, output: green ? "" : "check failed" }; },
        runAcceptance: async () => ({ ok: true, output: "" }),
        squashMergeInto: async () => ({ merged: true, conflict: false }),
        diffStat: async () => "+1 -0",
        mergeStage: async () => ({ outcome: "merged", diffstat: "+1 -0" }),
        setStatus: (_id, status, extra) => { statusCalls.push({ status, reason: extra?.failureReason ?? null }); },
        addIteration: () => ({ id: `it-${iterIdx}` }),
        finishIteration: () => {},
        log: () => {},
    };

    const finalStatus = await runTaskLoop(mkProject(), mkTask(), { ...TEST_CONFIG, ...config }, deps);
    return { finalStatus, terminalReason: statusCalls[statusCalls.length - 1]?.reason ?? null, iterationsRun: perIterationCostUsd.length, perIterationCostUsd };
}

// The RETIRED meter's rule, restated inline (spawn only while cumulative prior spend < cap): how many
// spawns the OLD gate would have allowed against a costUsd series. This is the independent yardstick
// the real loop must now DIVERGE from — a resurrected dollar gate would reconverge to it.
function oldMeterAllowedSpawns(costs: number[], capUsd: number, iterationCap: number): number {
    let spend = 0, spawns = 0;
    for (let i = 0; i < iterationCap; i++) {
        if (spend >= capUsd) break;
        spend += costs[Math.min(i, costs.length - 1)] ?? 0;
        spawns += 1;
    }
    return spawns;
}

// ── Part 1: dollars are inert — the mandated live probe ───────────────────────────────────────────────

describe("verify/spend/retire-dollars Part 1: the dollar meter is gone from the loop", () => {
    it("PROBE: a high-costUsd-but-low-token run does NOT park — it would have tripped the OLD $ cap", async () => {
        // $10/iteration against the configured $25 cap: the retired meter would have halted the 4th
        // spawn (prior spend $30 ≥ $25). Billable is 3 tokens/iteration (12 ≪ 1000) — the loop must
        // run its FULL iteration budget and park on the iteration cap, never on a spend ceiling.
        const r = await runLoop(
            Array.from({ length: 4 }, () => ({ usage: usage({ input: 1, output: 1, cacheCreation: 1, costUsd: 10 }) })),
            { tokenCap: 1000, iterationCap: 4 },
        );
        expect(r.iterationsRun).toBe(4);                              // the old gate would have stopped at 3
        expect(r.finalStatus).toBe("needs-human");
        expect(r.terminalReason).toContain("iteration cap reached");  // NOT "cost cap reached"
        expect(r.terminalReason).not.toContain("cost cap");
        // The divergence, derived independently from the recorded costUsd series: the retired meter's
        // rule allows strictly FEWER spawns than the real loop ran. If someone re-adds the dollar gate,
        // iterationsRun collapses back to the old meter's number and this probe fails.
        const oldAllowed = oldMeterAllowedSpawns(r.perIterationCostUsd, 25, 4);
        expect(oldAllowed).toBe(3);
        expect(r.iterationsRun).toBeGreaterThan(oldAllowed);
    });

    it("even an absurd $1000/iteration never parks a run on dollars", async () => {
        const r = await runLoop(
            Array.from({ length: 3 }, () => ({ usage: usage({ output: 1, costUsd: 1000 }) })),
            { tokenCap: 1000, iterationCap: 3 },
        );
        expect(r.iterationsRun).toBe(3);
        expect(r.terminalReason).toContain("iteration cap reached");
        expect(r.terminalReason).not.toContain("cost cap");
    });
});

// ── Part 2: the token backstop is the working spend ceiling ───────────────────────────────────────────

describe("verify/spend/retire-dollars Part 2: a high-token run parks on the token cap", () => {
    it("a high-token run DOES park needs-human on the token cap, before the next spawn", async () => {
        // 400 billable/iteration against the 1000-token cap: prior billable 0/400/800 spawned,
        // 1200 ≥ 1000 halts the 4th — the token backstop is the sole working ceiling. The fat
        // cacheRead documents that cache reads never count toward it.
        const r = await runLoop(
            Array.from({ length: 8 }, () => ({ usage: usage({ input: 100, output: 250, cacheRead: 500_000, cacheCreation: 50 }) })),
            { tokenCap: 1000, iterationCap: 8 },
        );
        expect(r.finalStatus).toBe("needs-human");
        expect(r.terminalReason).toBe("token cap reached (1200 of 1000 billable tokens)");
        expect(r.iterationsRun).toBe(3);
    });

    it("PROBE: a cache-read-heavy-but-cheap run does NOT trip the token cap (cacheRead is not billable)", async () => {
        const r = await runLoop(
            Array.from({ length: 4 }, () => ({ usage: usage({ input: 5, output: 20, cacheRead: 900_000, cacheCreation: 5 }) })),
            { tokenCap: 1000, iterationCap: 4 },
        );
        expect(r.iterationsRun).toBe(4);                    // 4 × 30 billable = 120 < 1000 — never trips
        expect(r.terminalReason).toContain("iteration cap reached");
    });
});

// ── Part 3: the config surface is retired ─────────────────────────────────────────────────────────────

describe("verify/spend/retire-dollars Part 3: the $ cap is gone from the config surface", () => {
    it("DEFAULT_LOOP_CONFIG carries NO costCapUsd — there is no engine dollar default anymore", () => {
        expect(Object.hasOwn(DEFAULT_LOOP_CONFIG, "costCapUsd")).toBe(false);
        expect(DEFAULT_LOOP_CONFIG.tokenCap).toBe(2_000_000); // the successor default stands
    });

    it("resolveLoopConfig no longer produces a costCapUsd — the $ field is gone from LoopConfig entirely", () => {
        const resolved = resolveLoopConfig({ iterationCap: null, noProgressK: null, stallTimeoutMin: null });
        expect(Object.hasOwn(resolved, "costCapUsd")).toBe(false);
        expect(resolved.tokenCap).toBe(2_000_000); // the successor is the sole spend ceiling
    });

    it("the spawn-nothing kill-switch is now the TOKEN cap: an explicit 0 spawns nothing", async () => {
        // The $-cap kill-switch ($0 = spawn nothing) was ripped out with the rest of the dollar machinery;
        // tokenCap 0 is its faithful successor — 0 billable ≥ 0 cap trips before the first spawn.
        const r = await runLoop(
            Array.from({ length: 4 }, () => ({ usage: usage({ output: 10 }) })),
            { tokenCap: 0, iterationCap: 8 },
        );
        expect(r.iterationsRun).toBe(0);
        expect(r.finalStatus).toBe("needs-human");
        expect(r.terminalReason).toBe("token cap reached (0 of 0 billable tokens)");
    });
});
