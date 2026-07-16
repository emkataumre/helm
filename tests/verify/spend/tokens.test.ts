// tests/verify/spend/tokens.test.ts
// The token-accounting verify slice, in two parts:
//   Part 1 — the HEADLINE: against a known claude stream-json result.usage fixture, summed through the
//   REAL aggregation path (applyEvent → recomputeTotals), the headline reconciles to OUTPUT tokens only.
//   PROBE: the old input+output sum MUST FAIL that reconciliation (and so must the fleet card's
//   sum-all-four-fields), proving the harness catches the exact accounting lie this slice fixes.
//   Part 2 — the TOKEN CAP (the M12 synthetic-$ cap's successor): a synthetic over-budget series trips
//   the cap in the REAL runTaskLoop to needs-human BEFORE the next spawn, denominated in BILLABLE tokens
//   (input + output + cacheCreation, cacheRead EXCLUDED). PROBE: a cache-read-heavy-but-cheap series
//   must NOT trip it — an accounting that wrongly counts cacheRead is caught two ways (the live scenario
//   runs its full budget, and a hand-crafted over-fire recording MUST FAIL the invariant).
//
// Non-circularity: Part 1 declares its ground truth as RAW stream-json field names (what claude's result
// event reports), independent of TokenTotals; Part 2 records each iteration's usage at the spawn seam and
// the invariants RE-DERIVE the billable series inline (input + output + cacheCreation, restated — NOT via
// billableTokens), so a leaked spawn or an over-fired cap is caught rather than tautologically confirmed.
// Self-contained in this one file — the costCap.test.ts shape.
import { describe, it, expect } from "vitest";
import { runTaskLoop, type RunTaskDeps } from "../../../src/main/engine/runTask";
import type { LoopConfig } from "../../../src/main/engine/loopConfig";
import { applyEvent, emptySnapshot, headlineTokens, billableTokens } from "../../../src/main/engine/verifyState";
import type { Project, Task, TaskStatus, TokenTotals } from "../../../src/shared/types";

// ── Part 1: the headline reconciles to OUTPUT tokens only ─────────────────────────────────────────────

// Ground truth in the RAW stream-json field names: two iterations' worth of result.usage, shaped like a
// real Ralph run (tiny non-cached input, real output, cache reads dwarfing everything else).
const RESULT_USAGE = [
    { input_tokens: 17, output_tokens: 294, cache_read_input_tokens: 183_213, cache_creation_input_tokens: 12_450 },
    { input_tokens: 41, output_tokens: 1_006, cache_read_input_tokens: 240_180, cache_creation_input_tokens: 3_071 },
];
// What the headline MUST reconcile to: the sum of result.usage.output_tokens and nothing else.
const EXPECTED_HEADLINE = RESULT_USAGE.reduce((n, u) => n + u.output_tokens, 0); // 1300
// What the cap's currency MUST reconcile to: input + output + cache-creation, cache reads excluded.
const EXPECTED_BILLABLE = RESULT_USAGE.reduce(
    (n, u) => n + u.input_tokens + u.output_tokens + u.cache_creation_input_tokens, 0); // 16879

// spawn.ts's capture mapping, restated: raw fields → TokenTotals, 1:1.
const toTotals = (u: (typeof RESULT_USAGE)[number]): TokenTotals => ({
    input: u.input_tokens, output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens, cacheCreation: u.cache_creation_input_tokens, costUsd: 0,
});

// Build the run's totals through the REAL aggregation path — iteration-start + usage events reduced by
// applyEvent (which recomputes totals from the per-iteration series) — not by summing here.
function aggregateThroughReducer(): TokenTotals {
    const s = emptySnapshot("t1", "running");
    RESULT_USAGE.forEach((u, i) => {
        applyEvent(s, { type: "iteration-start", index: i });
        applyEvent(s, { type: "usage", index: i, tokens: toTotals(u), sessionId: `sess-${i}` });
    });
    return s.totals;
}

// The candidate headline derivations. "output-only" is the shipped accounting; the other two are the
// bugs this slice exists to catch — each is a PROBE that MUST FAIL reconciliation.
const HEADLINE_CANDIDATES: Record<string, (t: TokenTotals) => number> = {
    "output-only": (t) => headlineTokens(t),
    "input-plus-output": (t) => t.input + t.output,                              // the old TaskDetail headline
    "sum-all-four-fields": (t) => t.input + t.output + t.cacheRead + t.cacheCreation, // the old fleet card
};

describe("verify/spend Part 1: the headline reconciles to result.usage output tokens only", () => {
    it("the reducer's totals faithfully aggregate the raw per-iteration usage (capture is 1:1)", () => {
        const totals = aggregateThroughReducer();
        expect(totals.input).toBe(17 + 41);
        expect(totals.output).toBe(294 + 1_006);
        expect(totals.cacheRead).toBe(183_213 + 240_180);
        expect(totals.cacheCreation).toBe(12_450 + 3_071);
    });

    it("headlineTokens over the REAL aggregated totals reconciles to output-only", () => {
        expect(headlineTokens(aggregateThroughReducer())).toBe(EXPECTED_HEADLINE);
    });

    it("PROBE: the input+output sum MUST FAIL the reconciliation (the lie is catchable)", () => {
        const candidate = HEADLINE_CANDIDATES["input-plus-output"]!(aggregateThroughReducer());
        expect(candidate).not.toBe(EXPECTED_HEADLINE); // 1358 ≠ 1300 — the harness catches the old headline
    });

    it("PROBE: the fleet card's sum-all-four-fields MUST FAIL the reconciliation", () => {
        const candidate = HEADLINE_CANDIDATES["sum-all-four-fields"]!(aggregateThroughReducer());
        expect(candidate).not.toBe(EXPECTED_HEADLINE);
    });

    it("billableTokens reconciles to input + output + cacheCreation — and EXCLUDES cacheRead", () => {
        expect(billableTokens(aggregateThroughReducer())).toBe(EXPECTED_BILLABLE);
        // The exclusion, isolated: a session that only re-read cache is billable-free.
        expect(billableTokens({ input: 0, output: 0, cacheRead: 1_000_000, cacheCreation: 0, costUsd: 0 })).toBe(0);
    });
});

// ── Part 2: the token cap in the REAL runTaskLoop ─────────────────────────────────────────────────────

const mkProject = (): Project => ({
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main",
    branchPrefix: "ralph", checkCommand: "npm run check", worktreeDir: ".helm/worktrees", setupCommand: null,
    iterationCap: null, noProgressK: null, stallTimeoutMin: null, costCapUsd: null, model: null, concurrencyCap: null,
    terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr", jailImage: null, conductorSessionId: null,
});
const mkTask = (): Task => ({
    id: "t1", projectId: "p1", title: "T", intent: "do", acceptance: ["x"], status: "queued", scopeHint: null,
    dependsOn: [], planId: null, branchName: null, worktreePath: null, diffstat: null, failureReason: null,
    createdAt: 0, updatedAt: 0,
});

// The $ cap is neutralized (Infinity) and every other breaker is out of reach, so the TOKEN cap is the
// sole breaker under observation; every step lands a fresh commit (no-progress never pre-empts).
const TEST_CONFIG: LoopConfig = { iterationCap: 8, noProgressK: 99, denyWallK: 99, mergeRecycleK: 0, costCapUsd: Number.POSITIVE_INFINITY, tokenCap: 1000, stallTimeoutMs: 1000, checkTimeoutMs: 1000 };

// One iteration's scripted world: the usage the spawn reports and whether the gate goes green.
interface TokenStep { usage: TokenTotals; checkGreen?: boolean }
interface TokenScenario { script: TokenStep[]; config?: Partial<LoopConfig> }

// The flat recording the invariants read.
interface TokenRecording {
    unit: "token-cap";
    finalStatus: TaskStatus;
    terminalReason: string | null;
    iterationsRun: number;            // iterations the REAL loop actually SPAWNED (spawn-seam count)
    iterationCap: number;
    tokenCap: number | undefined;
    escalatedTokenCap: boolean;       // the terminal reason is a token-cap termination
    perIterationUsage: TokenTotals[]; // ground truth: what each spawned iteration reported (spawn seam)
}

const usage = (u: Partial<TokenTotals>): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, ...u });

// Drive the REAL loop over a scenario and distil the recording.
async function runTokenScenario(scenario: TokenScenario): Promise<TokenRecording> {
    const config: LoopConfig = { ...TEST_CONFIG, ...scenario.config };
    const script = scenario.script;
    const perIterationUsage: TokenTotals[] = [];
    const statusCalls: { status: TaskStatus; reason: string | null }[] = [];
    let iterIdx = -1, headCalls = 0;
    let lastSha = "sha-base";
    const step = (): TokenStep => script[Math.min(iterIdx, script.length - 1)] ?? { usage: usage({}) };

    const deps: RunTaskDeps = {
        ensureBranch: async () => {}, checkoutBranch: async () => {},
        createWorktree: async () => "/repo/.helm/worktrees/ralph-task-t1",
        removeWorktree: async () => {},
        ensureRalphExcluded: () => {}, writeRalphFiles: () => {},
        runSetup: async () => ({ ok: true, output: "" }),
        spawnAgent: async () => {
            iterIdx += 1;
            const u = step().usage;
            perIterationUsage.push(u);
            return { ok: true, output: "did work", sessionId: `sess-${iterIdx}`, stalled: false, usage: u, durationMs: null, deniedCommands: [] };
        },
        commitAll: async () => {},
        headSha: async () => {
            if (headCalls++ === 0) return "sha-base"; // baseSha, read once before the loop
            lastSha = `sha-${iterIdx}`;               // every iteration lands a fresh commit
            return lastSha;
        },
        runCheck: async () => { const green = step().checkGreen ?? false; return { green, timedOut: false, output: green ? "" : "check failed" }; },
        runAcceptance: async () => ({ ok: true, output: "" }),
        squashMergeInto: async () => ({ merged: true, conflict: false }),
        diffStat: async () => "+1 -0",
        mergeStage: async () => ({ outcome: "merged", diffstat: "+1 -0" }),
        setStatus: (_id, status, extra) => { statusCalls.push({ status, reason: extra?.failureReason ?? null }); },
        addIteration: () => ({ id: `it-${perIterationUsage.length}` }),
        finishIteration: () => {},
        log: () => {},
    };

    const finalStatus = await runTaskLoop(mkProject(), mkTask(), config, deps);
    const terminalReason = statusCalls[statusCalls.length - 1]?.reason ?? null;
    return {
        unit: "token-cap",
        finalStatus,
        terminalReason,
        iterationsRun: perIterationUsage.length,
        iterationCap: config.iterationCap,
        tokenCap: config.tokenCap,
        escalatedTokenCap: (terminalReason ?? "").startsWith("token cap reached"),
        perIterationUsage,
    };
}

// ── Scenarios ─────────────────────────────────────────────────────────────────────────────────────────

// The over-budget series: 400 billable/iteration (100 in + 250 out + 50 cache-creation; the 500k cache
// reads DON'T count) against a 1000-token cap with red gates. Spawns run while prior billable is under
// the cap (before iters 0/1/2 → 0/400/800) and STOP before iter 3 (prior 1200 ≥ 1000) — needs-human
// BEFORE the next spawn, well before the iteration cap of 8.
const overBudgetTrips = (): TokenScenario => ({
    script: Array.from({ length: 8 }, () => ({ usage: usage({ input: 100, output: 250, cacheRead: 500_000, cacheCreation: 50 }) })),
    config: { tokenCap: 1000, iterationCap: 8 },
});

// THE mandated probe scenario: cache-read-HEAVY but billable-CHEAP — 900k cache reads but only 30
// billable tokens per iteration. The cap must NOT trip (4 × 30 = 120 < 1000): the loop runs its full
// iteration budget. An accounting that wrongly counted cacheRead would have parked after ONE iteration.
const cacheReadHeavyButCheapDoesNotTrip = (): TokenScenario => ({
    script: Array.from({ length: 4 }, () => ({ usage: usage({ input: 5, output: 20, cacheRead: 900_000, cacheCreation: 5 }) })),
    config: { tokenCap: 1000, iterationCap: 4 },
});

// A single GREEN iteration that itself blows past the cap still MERGES — the cap gates SPAWNS only
// (checked before the spawn, when prior billable was 0), the deliberate M12 symmetry.
const greenCrossingCapMerges = (): TokenScenario => ({
    script: [{ usage: usage({ input: 2_000, output: 2_000, cacheCreation: 1_000 }), checkGreen: true }],
    config: { tokenCap: 1000 },
});

// An explicit 0 cap means "spawn nothing": 0 billable ≥ 0 cap trips on the very first pass.
const zeroCapSpawnsNothing = (): TokenScenario => ({
    script: Array.from({ length: 4 }, () => ({ usage: usage({ output: 100 }) })),
    config: { tokenCap: 0, iterationCap: 8 },
});

// A pre-tokenCap LoopConfig (tokenCap undefined — every legacy verify-slice literal) is UNGATED: heavy
// usage runs to the iteration cap. Documents why adding the field can't disturb the older slices.
const undefinedCapIsUngated = (): TokenScenario => ({
    script: Array.from({ length: 3 }, () => ({ usage: usage({ input: 10_000, output: 10_000, cacheCreation: 10_000 }) })),
    config: { tokenCap: undefined, iterationCap: 3 },
});

// ── The invariants ────────────────────────────────────────────────────────────────────────────────────

// token-cap-respected: no iteration is spawned once the billable ceiling has been crossed. Re-derives the
// prior-billable series from the RAW recorded usage — input + output + cacheCreation restated inline,
// cacheRead deliberately EXCLUDED — so a leaked spawn is caught independently of the loop's own ledger.
function tokenCapRespected(r: TokenRecording): true | string {
    if (r.tokenCap === undefined) return true; // gate off — nothing to respect
    let billableBefore = 0;
    for (let j = 0; j < r.iterationsRun; j++) {
        if (billableBefore >= r.tokenCap) {
            return `iteration ${j + 1} spawned though prior billable ${billableBefore} had already reached the ${r.tokenCap}-token cap`;
        }
        const u = r.perIterationUsage[j] ?? usage({});
        billableBefore += u.input + u.output + u.cacheCreation;
    }
    return true;
}

// token-cap-not-overfired: a token-cap escalation is legitimate only if the run's total BILLABLE tokens
// actually reached the cap. This is what catches the cacheRead lie — an implementation that counts cache
// reads parks the cheap-but-cache-heavy series with a total billable far under the cap.
function tokenCapNotOverfired(r: TokenRecording): true | string {
    if (!r.escalatedTokenCap || r.tokenCap === undefined) return true;
    const totalBillable = r.perIterationUsage.reduce((n, u) => n + u.input + u.output + u.cacheCreation, 0);
    return totalBillable >= r.tokenCap
        || `token-cap escalation with only ${totalBillable} billable tokens of a ${r.tokenCap} cap — cacheRead must have been counted`;
}

const INVARIANTS: Record<string, (r: TokenRecording) => true | string> = {
    "token-cap-respected": tokenCapRespected,
    "token-cap-not-overfired": tokenCapNotOverfired,
};

// A predicate that THROWS becomes a failed check, never a silent pass.
function checkInvariants(r: TokenRecording): Array<{ name: string; ok: boolean; detail?: string }> {
    return Object.entries(INVARIANTS).map(([name, pred]) => {
        try {
            const verdict = pred(r);
            return verdict === true ? { name, ok: true } : { name, ok: false, detail: verdict };
        } catch (err) {
            return { name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────
// POSITIVE fixtures drive the REAL loop — every invariant must hold. A PROBE is a hand-crafted BROKEN
// recording that MUST FAIL its named invariant — proving the harness catches each lie.
interface PositiveFixture { id: string; probe?: false; run: () => Promise<TokenRecording> }
interface ProbeFixture { id: string; probe: true; recording: TokenRecording; mustFail: string }
type TokenFixture = PositiveFixture | ProbeFixture;

const FIXTURES: TokenFixture[] = [
    { id: "over-budget-trips", run: () => runTokenScenario(overBudgetTrips()) },
    { id: "cacheread-heavy-but-cheap-does-not-trip", run: () => runTokenScenario(cacheReadHeavyButCheapDoesNotTrip()) },
    { id: "green-crossing-cap-merges", run: () => runTokenScenario(greenCrossingCapMerges()) },
    { id: "zero-cap-spawns-nothing", run: () => runTokenScenario(zeroCapSpawnsNothing()) },
    { id: "undefined-cap-is-ungated", run: () => runTokenScenario(undefinedCapIsUngated()) },

    // Probe: three 3000-billable spawns against a 1000 cap — the SECOND began with 3000 of prior billable,
    // already past the cap, so it should never have happened. MUST FAIL token-cap-respected.
    {
        id: "spawn-after-cap", probe: true, mustFail: "token-cap-respected",
        recording: {
            unit: "token-cap", finalStatus: "needs-human", terminalReason: "token cap reached (9000 of 1000 billable tokens)",
            iterationsRun: 3, iterationCap: 8, tokenCap: 1000, escalatedTokenCap: true,
            perIterationUsage: Array.from({ length: 3 }, () => usage({ input: 1_000, output: 1_000, cacheCreation: 1_000 })),
        },
    },
    // Probe: the cacheRead lie — the cheap-but-cache-heavy series parked as a token-cap escalation with
    // only 30 billable tokens of a 1000 cap (only possible if cacheRead was counted as billable). MUST
    // FAIL token-cap-not-overfired.
    {
        id: "cacheread-counted-overfire", probe: true, mustFail: "token-cap-not-overfired",
        recording: {
            unit: "token-cap", finalStatus: "needs-human", terminalReason: "token cap reached (900030 of 1000 billable tokens)",
            iterationsRun: 1, iterationCap: 4, tokenCap: 1000, escalatedTokenCap: true,
            perIterationUsage: [usage({ input: 5, output: 20, cacheRead: 900_000, cacheCreation: 5 })],
        },
    },
];

type Verdict = "PASS" | "FAIL" | "BLOCKED";

// Positive → PASS iff every invariant holds against the REAL loop's recording; probe → PASS iff its
// named invariant FAILED (the harness caught the lie). BLOCKED (couldn't observe) is never a pass.
async function runFixture(f: TokenFixture): Promise<{ verdict: Verdict; checks: Array<{ name: string; ok: boolean; detail?: string }> }> {
    let recording: TokenRecording;
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

describe("verify/spend Part 2: the token cap in the REAL runTaskLoop", () => {
    it("a synthetic over-budget series trips the cap to needs-human BEFORE the next spawn", async () => {
        const r = await runTokenScenario(overBudgetTrips());
        expect(r.finalStatus).toBe("needs-human");
        expect(r.escalatedTokenCap).toBe(true);
        expect(r.terminalReason).toBe("token cap reached (1200 of 1000 billable tokens)");
        expect(r.iterationsRun).toBe(3);                    // prior billable 0/400/800 spawned; 1200 ≥ 1000 halts the 4th
        expect(r.iterationsRun).toBeLessThan(r.iterationCap);
        expect(tokenCapRespected(r)).toBe(true);
    });

    it("PROBE: a cache-read-heavy-but-cheap series must NOT trip the cap (cacheRead is not billable)", async () => {
        const r = await runTokenScenario(cacheReadHeavyButCheapDoesNotTrip());
        expect(r.escalatedTokenCap).toBe(false);            // 4 × 30 billable = 120 < 1000 — never trips
        expect(r.iterationsRun).toBe(4);                    // the full iteration budget ran
        expect(r.terminalReason).toContain("iteration cap reached");
        expect(tokenCapNotOverfired(r)).toBe(true);
    });

    it("a green iteration that crosses the cap still merges (the cap gates spawns, not merges)", async () => {
        const r = await runTokenScenario(greenCrossingCapMerges());
        expect(r.finalStatus).toBe("merged");
        expect(r.escalatedTokenCap).toBe(false);
        expect(r.terminalReason).toBeNull();                // merged clears any reason
        expect(r.iterationsRun).toBe(1);
    });

    it("an explicit 0 cap spawns nothing at all", async () => {
        const r = await runTokenScenario(zeroCapSpawnsNothing());
        expect(r.finalStatus).toBe("needs-human");
        expect(r.terminalReason).toBe("token cap reached (0 of 0 billable tokens)");
        expect(r.iterationsRun).toBe(0);
    });

    it("a legacy config without tokenCap is ungated — the older verify slices stay undisturbed", async () => {
        const r = await runTokenScenario(undefinedCapIsUngated());
        expect(r.escalatedTokenCap).toBe(false);
        expect(r.iterationsRun).toBe(3);                    // 90k billable spawned freely, to the iteration cap
        expect(r.terminalReason).toContain("iteration cap reached");
    });
});

describe("verify/spend Part 2: the CI matrix over every fixture", () => {
    it.each(FIXTURES.filter((f) => !f.probe).map((f) => [f.id, f] as const))(
        "honest fixture %s → PASS (the real loop respects the billable accounting)",
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

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = null as unknown as TokenRecording; // property access throws inside the predicates
        expect(checkInvariants(garbage).every((c) => !c.ok)).toBe(true);
    });
});
