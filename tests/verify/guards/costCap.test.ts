// tests/verify/guards/costCap.test.ts
// The M12 cost-cap verify slice, REPOINTED at the TOKEN cap — the $ cap's successor and now the SOLE
// spend ceiling. Sibling to the deny-fail-fast slice (surface/fixtures/invariants + trayCounts) —
// self-contained in this one file, same shape as trayCounts.test.ts. runTaskLoop has no DOM and no HTTP
// response; its observable SURFACE is what it did (final status, terminal reason, how many iterations it
// spawned). We drive the REAL, fully-DI'd runTaskLoop with recording fake deps that script, per
// iteration, the usage that spawn reported — BILLABLE tokens *and* a legacy costUsd figure — and whether
// the gate went green, then distil a flat SpendRecording the invariants read.
//
// What "repointed" means: the dollar CAP is retired (the USD accumulator and `spend >= costCapUsd`
// meter are gone from runTask.ts; costUsd survives as display accounting only), so this slice now
// proves TWO things — the token backstop halts spawns exactly like the old $ cap used to, AND a run
// that would have tripped the OLD $ cap but is under the token cap must NOT park (the retirement
// itself, as a live probe scenario).
//
// Non-circularity: each scenario DECLARES its ground truth — the per-iteration billable usage and USD
// figure, recorded at the spawn seam, independent of the loop's own accounting. The invariants RE-DERIVE
// the expected behaviour from those raw series (prior-billable strictly under the cap before every
// spawn; a positive $ cap may never park a run) and compare against the loop's ACTUAL behaviour, so a
// leaked spawn or a resurrected dollar gate is caught rather than tautologically confirmed.
import { describe, it, expect } from "vitest";
import { runTaskLoop, type RunTaskDeps } from "../../../src/main/engine/runTask";
import type { LoopConfig } from "../../../src/main/engine/loopConfig";
import type { TaskStatus, TokenTotals } from "../../../src/shared/types";
import { mkProject, mkTask } from "./surface";

const ZERO: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 };

// Tiny bounds so a scenario runs fast; per-scenario overrides set the caps + iteration budget under
// test. noProgressK is comfortably high AND every scripted step lands a fresh commit, so the no-progress
// breaker never pre-empts the spend ceiling; no denied keys, so the deny wall never fires either — the
// spend ceiling is the sole breaker under observation. costCapUsd is deliberately ABSENT by default:
// resolveLoopConfig only ever forwards a stored project value, and the retired field has no engine
// default anymore.
const TEST_CONFIG: LoopConfig = { iterationCap: 8, noProgressK: 99, denyWallK: 99, mergeRecycleK: 0, tokenCap: 1000, stallTimeoutMs: 1000, checkTimeoutMs: 1000 };

// One iteration's scripted world: the billable tokens and legacy USD figure the spawn reported, and
// whether the gate went green.
interface SpendStep { billable: number; costUsd: number; checkGreen?: boolean }
interface SpendScenario { script: SpendStep[]; config?: Partial<LoopConfig> }

// The flat recording the invariants read.
interface SpendRecording {
    unit: "cost-cap";
    finalStatus: TaskStatus;
    terminalReason: string | null;
    iterationsRun: number;            // iterations the REAL loop actually SPAWNED (spawn-seam count)
    iterationCap: number;
    tokenCap: number | undefined;
    costCapUsd: number | undefined;   // the config's retired $ figure (only 0 may ever act)
    escalatedTokenCap: boolean;       // the terminal reason is a token-cap termination
    escalatedDollarCap: boolean;      // the terminal reason is a $-cap termination (only legal at cap ≤ 0)
    perIterationBillable: number[];   // ground truth: billable tokens each spawned iteration reported
    perIterationCostUsd: number[];    // ground truth: the USD figure each spawned iteration carried
}

// Drive the REAL loop over a scenario and distil the recording.
async function runSpendScenario(scenario: SpendScenario): Promise<SpendRecording> {
    const config: LoopConfig = { ...TEST_CONFIG, ...scenario.config };
    const script = scenario.script;
    const perIterationBillable: number[] = [];
    const perIterationCostUsd: number[] = [];
    const statusCalls: { status: TaskStatus; reason: string | null }[] = [];
    let iterIdx = -1, headCalls = 0;
    let lastSha = "sha-base";
    const step = (): SpendStep => script[Math.min(iterIdx, script.length - 1)] ?? { billable: 0, costUsd: 0 };

    const deps: RunTaskDeps = {
        ensureBranch: async () => {}, checkoutBranch: async () => {},
        createWorktree: async () => "/repo/.helm/worktrees/ralph-task-t1",
        removeWorktree: async () => {},
        ensureRalphExcluded: () => {}, writeRalphFiles: () => {},
        runSetup: async () => ({ ok: true, output: "" }),
        spawnAgent: async () => {
            iterIdx += 1;
            const s = step();
            perIterationBillable.push(s.billable);
            perIterationCostUsd.push(s.costUsd);
            // The whole billable figure rides on output tokens (billable = input + output +
            // cacheCreation); a fat cacheRead documents that cache reads never count toward the cap.
            return { ok: true, output: "did work", sessionId: `sess-${iterIdx}`, stalled: false, usage: { ...ZERO, output: s.billable, cacheRead: 500_000, costUsd: s.costUsd }, durationMs: null, deniedCommands: [] };
        },
        commitAll: async () => {},
        headSha: async () => {
            if (headCalls++ === 0) return "sha-base"; // baseSha, read once before the loop
            lastSha = `sha-${iterIdx}`;               // every iteration lands a fresh commit (no-progress never fires)
            return lastSha;
        },
        runCheck: async () => { const green = step().checkGreen ?? false; return { green, timedOut: false, output: green ? "" : "check failed" }; },
        runAcceptance: async () => ({ ok: true, output: "" }),
        squashMergeInto: async () => ({ merged: true, conflict: false }),
        diffStat: async () => "+1 -0",
        mergeStage: async () => ({ outcome: "merged", diffstat: "+1 -0" }),
        setStatus: (_id, status, extra) => { statusCalls.push({ status, reason: extra?.failureReason ?? null }); },
        addIteration: () => ({ id: `it-${perIterationBillable.length}` }),
        finishIteration: () => {},
        log: () => {},
    };

    const finalStatus = await runTaskLoop(mkProject(), mkTask(), config, deps);
    const terminalReason = statusCalls[statusCalls.length - 1]?.reason ?? null;
    return {
        unit: "cost-cap",
        finalStatus,
        terminalReason,
        iterationsRun: perIterationBillable.length,
        iterationCap: config.iterationCap,
        tokenCap: config.tokenCap,
        costCapUsd: config.costCapUsd,
        escalatedTokenCap: (terminalReason ?? "").startsWith("token cap reached"),
        escalatedDollarCap: (terminalReason ?? "").startsWith("cost cap reached"),
        perIterationBillable,
        perIterationCostUsd,
    };
}

// ── Scenarios ───────────────────────────────────────────────────────────────────────────────────────────
const step = (billable: number, costUsd: number, over: Partial<SpendStep> = {}): SpendStep => ({ billable, costUsd, checkGreen: false, ...over });

// 400 billable/iteration against a 1000-token cap with red gates: spawns run while cumulative prior
// billable is under the cap (before iters 0/1/2 → 0/400/800) and STOP before iter 3 (prior 1200 ≥ 1000).
// The cap gates spawns, not the iteration budget — it fires at 3, well before the cap of 8.
const capHaltsSpawns = (): SpendScenario => ({ script: Array.from({ length: 8 }, () => step(400, 0)), config: { tokenCap: 1000, iterationCap: 8 } });

// THE mandated live probe scenario: a run that would have tripped the OLD $ cap but is under the token
// cap must NOT park. $10/iteration against the old default $25 cap — the retired meter would have halted
// the 4th spawn (prior spend $30 ≥ $25) — but each iteration is only 10 billable tokens (40 ≪ 1000), so
// the loop must run its FULL iteration budget and park on the iteration cap, never on a spend ceiling.
const oldDollarCapDoesNotPark = (): SpendScenario => ({ script: Array.from({ length: 6 }, () => step(10, 10)), config: { costCapUsd: 25, tokenCap: 1000, iterationCap: 6 } });

// A single GREEN iteration that itself blows past the token cap still MERGES: the cap is checked BEFORE
// the spawn (prior billable 0 < 1000), and a green iteration that crosses the cap lands normally (the
// deliberate spawns-only symmetry, carried over from the $ cap it replaced).
const greenCrossingCapMerges = (): SpendScenario => ({ script: [step(5_000, 0, { checkGreen: true })], config: { tokenCap: 1000 } });

// An explicit 0 token cap means "spawn nothing": the top-of-loop check (0 billable ≥ 0 cap) trips on the
// very first pass, so zero iterations are ever spawned.
const zeroTokenCapSpawnsNothing = (): SpendScenario => ({ script: Array.from({ length: 4 }, () => step(400, 0)), config: { tokenCap: 0, iterationCap: 8 } });

// The retired $ cap's one surviving contract: an explicit costCapUsd of 0 STILL spawns nothing (the
// kill-switch is a config flag, not a spend meter — with the accumulator gone, 0 is the only value the
// old gate could ever fire at).
const zeroDollarCapStillSpawnsNothing = (): SpendScenario => ({ script: Array.from({ length: 4 }, () => step(10, 0)), config: { costCapUsd: 0, tokenCap: 1000, iterationCap: 8 } });

// ── The invariants ──────────────────────────────────────────────────────────────────────────────────────

// token-cap-respected: no iteration is spawned once the billable ceiling has been crossed. Re-derive,
// from the recorded per-iteration billable series, the cumulative prior billable before each spawned
// iteration; every spawn must have begun strictly under the cap. An INDEPENDENT restatement of the
// loop's rule, so a leaked spawn is caught rather than tautologically confirmed.
function tokenCapRespected(r: SpendRecording): true | string {
    if (r.tokenCap === undefined) return true; // gate off — nothing to respect
    let billableBefore = 0;
    for (let j = 0; j < r.iterationsRun; j++) {
        if (billableBefore >= r.tokenCap) {
            return `iteration ${j + 1} spawned though cumulative prior billable ${billableBefore} had already reached the ${r.tokenCap}-token cap`;
        }
        billableBefore += r.perIterationBillable[j] ?? 0;
    }
    return true;
}

// dollar-cap-retired: with the USD meter severed, ONLY an explicit cap ≤ 0 (the spawn-nothing
// kill-switch) may ever terminate as a $-cap park. A positive $ cap producing a dollar-cap termination
// means the legacy `spend >= costCapUsd` gate came back from the dead — exactly the regression this
// slice exists to catch, however much the run "cost".
function dollarCapRetired(r: SpendRecording): true | string {
    if (!r.escalatedDollarCap) return true;
    if (r.costCapUsd !== undefined && r.costCapUsd <= 0) return true; // the kill-switch — legitimate
    const spent = r.perIterationCostUsd.reduce((a, c) => a + c, 0);
    return `a $-cap park fired against costCapUsd=${r.costCapUsd} (cumulative costUsd $${spent.toFixed(2)}) — the retired dollar meter is back`;
}

const INVARIANTS: Record<string, (r: SpendRecording) => true | string> = {
    "token-cap-respected": tokenCapRespected,
    "dollar-cap-retired": dollarCapRetired,
};

// runGuardInvariants-style wrapper: a predicate that THROWS becomes a failed check, never a silent pass.
function checkInvariants(r: SpendRecording): Array<{ name: string; ok: boolean; detail?: string }> {
    return Object.entries(INVARIANTS).map(([name, pred]) => {
        try {
            const verdict = pred(r);
            return verdict === true ? { name, ok: true } : { name, ok: false, detail: verdict };
        } catch (err) {
            return { name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────────
// POSITIVE fixtures drive the REAL loop — every invariant must hold. A PROBE is a hand-crafted BROKEN
// recording that MUST FAIL its named invariant — proving the harness catches each lie.
interface PositiveFixture { id: string; probe?: false; run: () => Promise<SpendRecording> }
interface ProbeFixture { id: string; probe: true; recording: SpendRecording; mustFail: string }
type SpendFixture = PositiveFixture | ProbeFixture;

const FIXTURES: SpendFixture[] = [
    { id: "token-cap-halts-spawns", run: () => runSpendScenario(capHaltsSpawns()) },
    { id: "old-dollar-cap-does-not-park", run: () => runSpendScenario(oldDollarCapDoesNotPark()) },
    { id: "green-crossing-cap-merges", run: () => runSpendScenario(greenCrossingCapMerges()) },
    { id: "zero-token-cap-spawns-nothing", run: () => runSpendScenario(zeroTokenCapSpawnsNothing()) },
    { id: "zero-dollar-cap-still-spawns-nothing", run: () => runSpendScenario(zeroDollarCapStillSpawnsNothing()) },

    // Probe (deliberately wrong): three 3000-billable spawns against a 1000-token cap. The SECOND spawn
    // began with 3000 of prior billable — already past the cap — so it should never have happened. MUST
    // FAIL token-cap-respected.
    {
        id: "spawn-after-token-cap", probe: true, mustFail: "token-cap-respected",
        recording: {
            unit: "cost-cap", finalStatus: "needs-human", terminalReason: "token cap reached (9000 of 1000 billable tokens)",
            iterationsRun: 3, iterationCap: 8, tokenCap: 1000, costCapUsd: undefined,
            escalatedTokenCap: true, escalatedDollarCap: false,
            perIterationBillable: [3000, 3000, 3000], perIterationCostUsd: [0, 0, 0],
        },
    },
    // Probe (deliberately wrong): the resurrected dollar gate — a run under the token cap parked as a
    // $-cap termination against the old default $25 (positive) cap. This is precisely "a run that would
    // have tripped the OLD $ cap" being parked, which the retirement forbids. MUST FAIL
    // dollar-cap-retired.
    {
        id: "dollar-park-under-token-cap", probe: true, mustFail: "dollar-cap-retired",
        recording: {
            unit: "cost-cap", finalStatus: "needs-human", terminalReason: "cost cap reached ($30.00 of $25 cap)",
            iterationsRun: 3, iterationCap: 8, tokenCap: 1000, costCapUsd: 25,
            escalatedTokenCap: false, escalatedDollarCap: true,
            perIterationBillable: [10, 10, 10], perIterationCostUsd: [10, 10, 10],
        },
    },
];

type Verdict = "PASS" | "FAIL" | "BLOCKED";

// Run one fixture: positive → PASS iff every invariant holds against the REAL loop's recording; probe →
// PASS iff its named invariant FAILED (the harness caught the lie). BLOCKED (couldn't observe) is never
// a pass.
async function runFixture(f: SpendFixture): Promise<{ verdict: Verdict; checks: Array<{ name: string; ok: boolean; detail?: string }> }> {
    let recording: SpendRecording;
    try {
        recording = f.probe ? f.recording : await f.run();
    } catch (err) {
        return { verdict: "BLOCKED", checks: [{ name: "recording", ok: false, detail: `could not build recording — threw: ${(err as Error)?.message ?? String(err)}` }] };
    }
    const checks = checkInvariants(recording);
    if (f.probe) {
        const caught = checks.some((c) => c.name === f.mustFail && !c.ok);
        return { verdict: caught ? "PASS" : "FAIL", checks };
    }
    return { verdict: checks.every((c) => c.ok) ? "PASS" : "FAIL", checks };
}

describe("verify/guards/costCap Part 1: the token backstop in the REAL runTaskLoop", () => {
    it("stops spawning once accumulated billable tokens cross the cap — before the iteration cap", async () => {
        const r = await runSpendScenario(capHaltsSpawns());
        expect(r.finalStatus).toBe("needs-human");
        expect(r.escalatedTokenCap).toBe(true);
        expect(r.terminalReason).toBe("token cap reached (1200 of 1000 billable tokens)");
        expect(r.iterationsRun).toBe(3);                    // prior billable 0/400/800 spawned; 1200 ≥ 1000 halts the 4th
        expect(r.iterationsRun).toBeLessThan(r.iterationCap);
        expect(tokenCapRespected(r)).toBe(true);
    });

    it("PROBE: a run that would have tripped the OLD $ cap but is under the token cap does NOT park", async () => {
        const r = await runSpendScenario(oldDollarCapDoesNotPark());
        expect(r.escalatedDollarCap).toBe(false);           // the retired meter never fires at a positive cap
        expect(r.escalatedTokenCap).toBe(false);            // 6 × 10 billable = 60 ≪ 1000
        expect(r.iterationsRun).toBe(6);                    // the FULL budget ran — the old gate would have halted at 3
        expect(r.terminalReason).toContain("iteration cap reached");
        expect(dollarCapRetired(r)).toBe(true);
    });

    it("a green iteration that crosses the cap still merges (the cap gates spawns, not merges)", async () => {
        const r = await runSpendScenario(greenCrossingCapMerges());
        expect(r.finalStatus).toBe("merged");
        expect(r.escalatedTokenCap).toBe(false);
        expect(r.terminalReason).toBeNull();                // merged clears any reason
        expect(r.iterationsRun).toBe(1);
        expect(tokenCapRespected(r)).toBe(true);
    });

    it("an explicit 0 token cap spawns nothing at all", async () => {
        const r = await runSpendScenario(zeroTokenCapSpawnsNothing());
        expect(r.finalStatus).toBe("needs-human");
        expect(r.escalatedTokenCap).toBe(true);
        expect(r.terminalReason).toBe("token cap reached (0 of 0 billable tokens)");
        expect(r.iterationsRun).toBe(0);
    });

    it("the retired $ cap's kill-switch survives: an explicit $0 cap still spawns nothing", async () => {
        const r = await runSpendScenario(zeroDollarCapStillSpawnsNothing());
        expect(r.finalStatus).toBe("needs-human");
        expect(r.escalatedDollarCap).toBe(true);
        expect(r.terminalReason).toBe("cost cap reached ($0.00 of $0 cap)");
        expect(r.iterationsRun).toBe(0);
        expect(dollarCapRetired(r)).toBe(true);             // cap ≤ 0 is the one legitimate $-cap park
    });
});

describe("verify/guards/costCap Part 2: the CI matrix over every fixture", () => {
    it.each(FIXTURES.filter((f) => !f.probe).map((f) => [f.id, f] as const))(
        "honest fixture %s → PASS (the real loop respects the token backstop)",
        async (_id, fixture) => {
            expect<Verdict>((await runFixture(fixture)).verdict).toBe("PASS");
        },
    );

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it.each(FIXTURES.filter((f) => f.probe).map((f) => [f.id, f] as const))(
        "probe %s → MUST FAIL its invariant (the harness catches the lie)",
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

describe("verify/guards/costCap Part 3: the re-derivation is independent of the loop", () => {
    it("the token probe recording genuinely violates token-cap-respected (a spawn after the cap)", () => {
        const probe = FIXTURES.find((f) => f.id === "spawn-after-token-cap")!;
        const rec = (probe as ProbeFixture).recording;
        const verdict = tokenCapRespected(rec);
        expect(verdict).not.toBe(true);
        expect(String(verdict)).toContain("iteration 2 spawned");
    });

    it("the dollar probe recording genuinely violates dollar-cap-retired (a positive-$-cap park)", () => {
        const probe = FIXTURES.find((f) => f.id === "dollar-park-under-token-cap")!;
        const verdict = dollarCapRetired((probe as ProbeFixture).recording);
        expect(verdict).not.toBe(true);
        expect(String(verdict)).toContain("retired dollar meter");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = null as unknown as SpendRecording; // property access throws inside the predicates
        expect(checkInvariants(garbage).every((c) => !c.ok)).toBe(true);
    });
});
