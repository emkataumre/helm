// tests/verify/guards/costCap.test.ts
// The M12 per-task cost-cap verify slice. Sibling to the deny-fail-fast slice (surface/fixtures/invariants +
// trayCounts) — self-contained in this one file, same shape as trayCounts.test.ts. runTaskLoop has no DOM and
// no HTTP response; its observable SURFACE is what it did (final status, terminal reason, how many iterations
// it spawned). We drive the REAL, fully-DI'd runTaskLoop with recording fake deps that script, per iteration,
// exactly how many USD that spawn cost and whether the gate went green — then distil a flat CostRecording the
// invariant reads.
//
// Non-circularity: each scenario DECLARES its ground truth — the per-iteration cost, recorded at the spawn
// seam, independent of the loop's own accounting. The invariant RE-DERIVES the expected "spend before this
// iteration" from those raw costs (an independent restatement of the rule: a spawn is legitimate only while
// the cumulative prior spend is still under the cap) and compares it against the loop's ACTUAL behaviour
// (how many iterations it spawned). A spawn that happened after the ceiling was crossed is caught.
import { describe, it, expect } from "vitest";
import { runTaskLoop, type RunTaskDeps } from "../../../src/main/engine/runTask";
import type { LoopConfig } from "../../../src/main/engine/loopConfig";
import type { TaskStatus, TokenTotals } from "../../../src/shared/types";
import { mkProject, mkTask } from "./surface";

const ZERO: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 };

// Tiny bounds so a scenario runs fast; per-scenario overrides set the cap + iteration budget under test.
// noProgressK is comfortably high AND every scripted step lands a fresh commit, so the no-progress breaker
// never pre-empts the cost cap; no denied keys, so the deny wall never fires either — the cost cap is the
// sole breaker under observation.
const TEST_CONFIG: LoopConfig = { iterationCap: 8, noProgressK: 5, denyWallK: 99, mergeRecycleK: 0, costCapUsd: 25, stallTimeoutMs: 1000, checkTimeoutMs: 1000 };

// One iteration's scripted world: what the spawn cost (USD) and whether the gate went green.
interface CostStep { costUsd: number; checkGreen?: boolean }
interface CostScenario { script: CostStep[]; config?: Partial<LoopConfig> }

// The flat recording the invariant reads.
interface CostRecording {
    unit: "cost-cap";
    finalStatus: TaskStatus;
    terminalReason: string | null;
    iterationsRun: number;       // iterations the REAL loop actually SPAWNED (spawn-seam count)
    iterationCap: number;
    costCapUsd: number;
    escalatedCostCap: boolean;   // the terminal reason is a cost-cap termination
    perIterationCost: number[];  // ground truth: what each spawned iteration cost (recorded at the spawn seam)
}

// Drive the REAL loop over a scenario and distil the recording.
async function runCostScenario(scenario: CostScenario): Promise<CostRecording> {
    const config: LoopConfig = { ...TEST_CONFIG, ...scenario.config };
    const script = scenario.script;
    const perIterationCost: number[] = [];
    const statusCalls: { status: TaskStatus; reason: string | null }[] = [];
    let iterIdx = -1, headCalls = 0;
    let lastSha = "sha-base";
    const step = (): CostStep => script[Math.min(iterIdx, script.length - 1)] ?? { costUsd: 0 };

    const deps: RunTaskDeps = {
        ensureBranch: async () => {}, checkoutBranch: async () => {},
        createWorktree: async () => "/repo/.helm/worktrees/ralph-task-t1",
        removeWorktree: async () => {},
        ensureRalphExcluded: () => {}, writeRalphFiles: () => {},
        runSetup: async () => ({ ok: true, output: "" }),
        spawnAgent: async () => {
            iterIdx += 1;
            const cost = step().costUsd;
            perIterationCost.push(cost);
            return { ok: true, output: "did work", sessionId: `sess-${iterIdx}`, stalled: false, usage: { ...ZERO, costUsd: cost }, durationMs: null, deniedCommands: [] };
        },
        commitAll: async () => {},
        headSha: async () => {
            if (headCalls++ === 0) return "sha-base"; // baseSha, read once before the loop
            lastSha = `sha-${iterIdx}`;                // every iteration lands a fresh commit (no-progress never fires)
            return lastSha;
        },
        runCheck: async () => { const green = step().checkGreen ?? false; return { green, timedOut: false, output: green ? "" : "check failed" }; },
        runAcceptance: async () => ({ ok: true, output: "" }),
        squashMergeInto: async () => ({ merged: true, conflict: false }),
        diffStat: async () => "+1 -0",
        mergeStage: async () => ({ outcome: "merged", diffstat: "+1 -0" }),
        setStatus: (_id, status, extra) => { statusCalls.push({ status, reason: extra?.failureReason ?? null }); },
        addIteration: () => ({ id: `it-${perIterationCost.length}` }),
        finishIteration: () => {},
        log: () => {},
    };

    const finalStatus = await runTaskLoop(mkProject(), mkTask(), config, deps);
    const terminalReason = statusCalls[statusCalls.length - 1]?.reason ?? null;
    return {
        unit: "cost-cap",
        finalStatus,
        terminalReason,
        iterationsRun: perIterationCost.length,
        iterationCap: config.iterationCap,
        costCapUsd: config.costCapUsd,
        escalatedCostCap: (terminalReason ?? "").startsWith("cost cap reached"),
        perIterationCost,
    };
}

// ── Scenarios ───────────────────────────────────────────────────────────────────────────────────────────
const step = (costUsd: number, over: Partial<CostStep> = {}): CostStep => ({ costUsd, checkGreen: false, ...over });

// $10/iteration against a $25 cap with red gates: spawns run while cumulative prior spend is under the cap
// (before iters 0/1/2 → $0/$10/$20) and STOP before iter 3 (prior spend $30 ≥ $25). Cap gates spawns, not the
// iteration budget — it fires at 3, well before the cap of 8.
const capHaltsSpawns = (): CostScenario => ({ script: Array.from({ length: 8 }, () => step(10)), config: { costCapUsd: 25, iterationCap: 8 } });

// A single GREEN iteration that itself costs $30 (> the $25 cap) still MERGES: the cap is checked BEFORE the
// spawn (prior spend $0 < $25), and a green iteration that crosses the cap lands normally (the deliberate
// spawns-only symmetry). No second spawn is ever gated because the task already merged.
const greenCrossingCapMerges = (): CostScenario => ({ script: [step(30, { checkGreen: true })], config: { costCapUsd: 25 } });

// Cheap iterations ($1) never reach the $25 cap, so the cost cap NEVER fires — the loop runs its full
// iteration budget (4) and terminates on the iteration cap instead. Proves the cost cap does not over-fire.
const underCapRunsToIterationCap = (): CostScenario => ({ script: Array.from({ length: 4 }, () => step(1)), config: { costCapUsd: 25, iterationCap: 4 } });

// An explicit $0 cap means "spawn nothing": the top-of-loop check ($0 spend ≥ $0 cap) trips on the very first
// pass, so zero iterations are ever spawned.
const zeroCapSpawnsNothing = (): CostScenario => ({ script: Array.from({ length: 4 }, () => step(10)), config: { costCapUsd: 0, iterationCap: 8 } });

// ── The invariant ───────────────────────────────────────────────────────────────────────────────────────
// cost-cap-respected: no iteration is spawned once the ceiling has been crossed. Re-derive, from the recorded
// per-iteration costs, the cumulative spend BEFORE each spawned iteration; every spawn must have begun with
// that prior spend strictly under the cap. This is an INDEPENDENT restatement of the loop's rule, so a spawn
// that happened after the cap was crossed (a leaked spawn) is caught rather than tautologically confirmed.
function costCapRespected(r: CostRecording): true | string {
    let spendBefore = 0;
    for (let j = 0; j < r.iterationsRun; j++) {
        if (spendBefore >= r.costCapUsd) {
            return `iteration ${j + 1} spawned though cumulative prior spend $${spendBefore.toFixed(2)} had already reached the $${r.costCapUsd} cap`;
        }
        spendBefore += r.perIterationCost[j] ?? 0;
    }
    return true;
}

// runGuardInvariants-style wrapper: a predicate that THROWS becomes a failed check, never a silent pass.
function checkInvariant(r: CostRecording): { name: string; ok: boolean; detail?: string } {
    const name = "cost-cap-respected";
    try {
        const verdict = costCapRespected(r);
        return verdict === true ? { name, ok: true } : { name, ok: false, detail: verdict };
    } catch (err) {
        return { name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
    }
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────
// POSITIVE fixtures drive the REAL loop — the invariant must hold. A PROBE is a hand-crafted BROKEN recording
// (a spawn that happened after the cap was crossed) that MUST FAIL — proving the harness catches a lie.
interface PositiveFixture { id: string; probe?: false; run: () => Promise<CostRecording> }
interface ProbeFixture { id: string; probe: true; recording: CostRecording; mustFail: string }
type CostFixture = PositiveFixture | ProbeFixture;

const FIXTURES: CostFixture[] = [
    { id: "cap-halts-spawns", run: () => runCostScenario(capHaltsSpawns()) },
    { id: "green-crossing-cap-merges", run: () => runCostScenario(greenCrossingCapMerges()) },
    { id: "under-cap-runs-to-iteration-cap", run: () => runCostScenario(underCapRunsToIterationCap()) },
    { id: "zero-cap-spawns-nothing", run: () => runCostScenario(zeroCapSpawnsNothing()) },

    // Probe (deliberately wrong): three $30 spawns against a $25 cap. The SECOND spawn began with $30 of prior
    // spend — already past the cap — so it should never have happened. MUST FAIL cost-cap-respected.
    {
        id: "spawn-after-cap", probe: true, mustFail: "cost-cap-respected",
        recording: {
            unit: "cost-cap", finalStatus: "needs-human", terminalReason: "cost cap reached ($60.00 of $25 cap)",
            iterationsRun: 3, iterationCap: 8, costCapUsd: 25, escalatedCostCap: true,
            perIterationCost: [30, 30, 30],
        },
    },
];

type Verdict = "PASS" | "FAIL" | "BLOCKED";

// Run one fixture: positive → PASS iff the invariant holds against the REAL loop's recording; probe → PASS
// iff the invariant FAILED (the harness caught the lie). BLOCKED (couldn't observe) is never a pass.
async function runFixture(f: CostFixture): Promise<{ verdict: Verdict; check: { name: string; ok: boolean; detail?: string } }> {
    let recording: CostRecording;
    try {
        recording = f.probe ? f.recording : await f.run();
    } catch (err) {
        return { verdict: "BLOCKED", check: { name: "cost-cap-respected", ok: false, detail: `could not build recording — threw: ${(err as Error)?.message ?? String(err)}` } };
    }
    const check = checkInvariant(recording);
    if (f.probe) {
        const caught = check.name === f.mustFail && !check.ok;
        return { verdict: caught ? "PASS" : "FAIL", check };
    }
    return { verdict: check.ok ? "PASS" : "FAIL", check };
}

describe("verify/guards/costCap Part 1: the cost-cap breaker in the REAL runTaskLoop", () => {
    it("stops spawning once accumulated spend crosses the cap — before the iteration cap", async () => {
        const r = await runCostScenario(capHaltsSpawns());
        expect(r.finalStatus).toBe("needs-human");
        expect(r.escalatedCostCap).toBe(true);
        expect(r.terminalReason).toBe("cost cap reached ($30.00 of $25 cap)");
        expect(r.iterationsRun).toBe(3);                    // $0/$10/$20 spawned; $30 ≥ $25 halts the 4th
        expect(r.iterationsRun).toBeLessThan(r.iterationCap);
        expect(costCapRespected(r)).toBe(true);
    });

    it("a green iteration that crosses the cap still merges (the cap gates spawns, not merges)", async () => {
        const r = await runCostScenario(greenCrossingCapMerges());
        expect(r.finalStatus).toBe("merged");
        expect(r.escalatedCostCap).toBe(false);
        expect(r.terminalReason).toBeNull();                // merged clears any reason
        expect(r.iterationsRun).toBe(1);
        expect(costCapRespected(r)).toBe(true);
    });

    it("cheap iterations never trip the cap — the loop runs its full iteration budget", async () => {
        const r = await runCostScenario(underCapRunsToIterationCap());
        expect(r.finalStatus).toBe("needs-human");
        expect(r.escalatedCostCap).toBe(false);
        expect(r.terminalReason).toContain("iteration cap reached");
        expect(r.iterationsRun).toBe(4);
        expect(costCapRespected(r)).toBe(true);
    });

    it("an explicit $0 cap spawns nothing at all", async () => {
        const r = await runCostScenario(zeroCapSpawnsNothing());
        expect(r.finalStatus).toBe("needs-human");
        expect(r.escalatedCostCap).toBe(true);
        expect(r.terminalReason).toBe("cost cap reached ($0.00 of $0 cap)");
        expect(r.iterationsRun).toBe(0);
        expect(costCapRespected(r)).toBe(true);
    });
});

describe("verify/guards/costCap Part 2: the CI matrix over every fixture", () => {
    it.each(FIXTURES.filter((f) => !f.probe).map((f) => [f.id, f] as const))(
        "honest fixture %s → PASS (the real loop respects the cap)",
        async (_id, fixture) => {
            expect<Verdict>((await runFixture(fixture)).verdict).toBe("PASS");
        },
    );

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it.each(FIXTURES.filter((f) => f.probe).map((f) => [f.id, f] as const))(
        "probe %s → MUST FAIL (the harness catches the leaked spawn)",
        async (_id, fixture) => {
            expect<Verdict>((await runFixture(fixture)).verdict).toBe("PASS"); // PASS == the probe's invariant FAILED
        },
    );

    it("every fixture reports a verdict, all PASS, none BLOCKED", async () => {
        const results = await Promise.all(FIXTURES.map(runFixture));
        expect(results).toHaveLength(FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});

describe("verify/guards/costCap Part 2: the re-derivation is independent of the loop", () => {
    it("the probe recording genuinely violates cost-cap-respected (a spawn after the cap was crossed)", () => {
        const probe = FIXTURES.find((f) => f.id === "spawn-after-cap")!;
        const rec = (probe as ProbeFixture).recording;
        const verdict = costCapRespected(rec);
        expect(verdict).not.toBe(true);
        expect(String(verdict)).toContain("iteration 2 spawned");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = null as unknown as CostRecording; // property access throws inside the predicate
        expect(checkInvariant(garbage).ok).toBe(false);
    });
});
