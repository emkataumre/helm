// tests/verify/review/reopen.test.ts
// The post-green review phase (M20, re-open on finding) verify slice, in two parts:
//   Part 1 — the BEHAVIOUR: driving the REAL runTaskLoop with fake deps, a review pass that FLAGS the
//   now-green work (a non-empty reviewFinding) re-opens the task into a work iteration drawing from the
//   REMAINING iterationCap, resets the consecutive-clean streak (the re-fix is re-reviewed FROM SCRATCH),
//   and finalizes (merges) ONLY after K consecutive clean reviews. A flag with no work budget left parks
//   the task ('review flagged issues, work budget exhausted'). A review that fails to complete still parks
//   (unconfirmed), unchanged from the confirm-only slice.
//   Part 2 — the CI matrix over every fixture + the declared invariants and their must-FAIL probes.
//
// THE mandated probes (must FAIL): (a) a re-fix that FINALIZES without re-earning K clean reviews; (b) a
// re-open that draws from a SEPARATE INFINITE budget instead of iterationCap (more work spawns than the cap).
//
// Non-circularity: the recording's ground truth is the ORDERED spawn-kind sequence read at the spawn seam
// (a spawn is a "review" iff its prompt carries buildReviewPrompt's stable frame — a guard test pins that
// frame), and the addIteration seam is recorded SEPARATELY; the invariants re-derive the work/review counts
// from that ordered sequence rather than trusting any loop-internal counter. Self-contained in this one file
// (the phase.test.ts shape). Runs headless under `npm run check`, zero prod footprint.
import { describe, it, expect } from "vitest";
import { runTaskLoop, type RunTaskDeps } from "../../../src/main/engine/runTask";
import type { LoopConfig } from "../../../src/main/engine/loopConfig";
import { buildGoalPrompt, buildReviewPrompt } from "../../../src/main/engine/prompt";
import type { Project, Task, TaskStatus, TokenTotals } from "../../../src/shared/types";

// The stable frame the loop stamps on a review /goal — the same substring the chokepoint keys off to tell a
// review spawn apart from a work spawn. Pinned against the real builder by a guard test below.
const REVIEW_MARKER = "You are REVIEWING";

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

// Every non-review breaker is neutralized (out of reach) so the post-green review phase is the sole thing
// under observation; each work iteration lands a fresh commit (no-progress never pre-empts).
const TEST_CONFIG: LoopConfig = {
    iterationCap: 5, noProgressK: 99, denyWallK: 99, mergeRecycleK: 0,
    costCapUsd: Number.POSITIVE_INFINITY, tokenCap: Number.POSITIVE_INFINITY, postGreenReviewK: 2,
    stallTimeoutMs: 1000, checkTimeoutMs: 1000,
};

type SpawnKind = "work" | "review";
// A review pass verdict at the spawn seam: clean (found nothing), flag (judged NOT good → re-open), or
// fail (the spawn didn't complete → park unconfirmed).
type ReviewVerdict = "clean" | "flag" | "fail";

// A scenario's scripted world. greenAt is the SET of 0-based WORK-iteration indices whose gate goes green
// (a work index not in the set → red gate, a normal fix-loop continue). reviewVerdicts is the ORDERED list
// of verdicts, consumed one per review spawn in fire order.
interface ReopenScenario {
    id: string;
    iterationCap: number;
    postGreenReviewK: number;
    greenAt: number[];
    reviewVerdicts: ReviewVerdict[];
}

// The flat recording the invariants read.
interface ReopenRecording {
    unit: "review-reopen";
    finalStatus: TaskStatus;
    terminalReason: string | null;
    spawnKinds: SpawnKind[];      // ORDERED ground truth at the spawn seam (work vs review, in fire order)
    iterationsRecorded: number;   // addIteration calls — the WORK-iteration-only seam (reviews must NOT show here)
    iterationCap: number;
    postGreenReviewK: number;
    merged: boolean;
}

const usage = (u: Partial<TokenTotals> = {}): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, ...u });
const workSpawnsOf = (r: ReopenRecording): number => r.spawnKinds.filter((k) => k === "work").length;
const reviewSpawnsOf = (r: ReopenRecording): number => r.spawnKinds.filter((k) => k === "review").length;
// The trailing run of review spawns at the very end of the sequence — for a MERGED task these are exactly
// the consecutive clean reviews that finalized it (a flag would have appended a work spawn; a fail would
// have parked). Re-derived from the ordered seam, independent of any loop counter.
const trailingReviewsOf = (r: ReopenRecording): number => {
    let n = 0;
    for (let i = r.spawnKinds.length - 1; i >= 0 && r.spawnKinds[i] === "review"; i--) n += 1;
    return n;
};

// Drive the REAL loop over a scenario and distil the recording.
async function runReopenScenario(s: ReopenScenario): Promise<ReopenRecording> {
    const config: LoopConfig = { ...TEST_CONFIG, iterationCap: s.iterationCap, postGreenReviewK: s.postGreenReviewK };
    const greenSet = new Set(s.greenAt);
    const spawnKinds: SpawnKind[] = [];
    const statusCalls: { status: TaskStatus; reason: string | null }[] = [];
    let workIdx = -1, reviewIdx = -1, headCalls = 0, iterationsRecorded = 0;

    const deps: RunTaskDeps = {
        ensureBranch: async () => {}, checkoutBranch: async () => {},
        createWorktree: async () => "/repo/.helm/worktrees/ralph-task-t1",
        removeWorktree: async () => {},
        ensureRalphExcluded: () => {}, writeRalphFiles: () => {},
        runSetup: async () => ({ ok: true, output: "" }),
        spawnAgent: async (_wt, prompt) => {
            // A review spawn is identified by buildReviewPrompt's stable frame — the same discriminator
            // production uses; work spawns carry buildGoalPrompt (no such frame).
            if (prompt.includes(REVIEW_MARKER)) {
                reviewIdx += 1;
                spawnKinds.push("review");
                const verdict = s.reviewVerdicts[reviewIdx] ?? "clean";
                const ok = verdict !== "fail";
                // A "flag" carries a non-empty reviewFinding (the review judged the work NOT good); "clean"
                // leaves it null; "fail" didn't complete (ok=false), so its finding is irrelevant.
                const reviewFinding = verdict === "flag" ? "the counts do not reconcile — fix them" : null;
                return { ok, output: ok ? "reviewed" : "review crashed", sessionId: `rev-${reviewIdx}`, stalled: false, usage: usage(), durationMs: null, deniedCommands: [], reviewFinding };
            }
            workIdx += 1;
            spawnKinds.push("work");
            return { ok: true, output: "did work", sessionId: `sess-${workIdx}`, stalled: false, usage: usage(), durationMs: null, deniedCommands: [] };
        },
        commitAll: async () => {},
        headSha: async () => {
            if (headCalls++ === 0) return "sha-base";     // baseSha, read once before the loop
            return `sha-${workIdx}`;                       // each work iteration lands a fresh commit (no-progress never fires)
        },
        // The gate goes green ONLY on the scripted work iterations; the review phase never re-runs runCheck,
        // so a green here fires exactly once per reached-green work iteration.
        runCheck: async () => { const green = greenSet.has(workIdx); return { green, timedOut: false, output: green ? "" : "check failed" }; },
        runAcceptance: async () => ({ ok: true, output: "" }),
        squashMergeInto: async () => ({ merged: true, conflict: false }),
        diffStat: async () => "+1 -0",
        mergeStage: async () => ({ outcome: "merged", diffstat: "+1 -0" }),
        setStatus: (_id, status, extra) => { statusCalls.push({ status, reason: extra?.failureReason ?? null }); },
        addIteration: () => { iterationsRecorded += 1; return { id: `it-${iterationsRecorded}` }; },
        finishIteration: () => {},
        log: () => {},
    };

    const finalStatus = await runTaskLoop(mkProject(), mkTask(), config, deps);
    const terminalReason = statusCalls[statusCalls.length - 1]?.reason ?? null;
    return {
        unit: "review-reopen",
        finalStatus, terminalReason, spawnKinds, iterationsRecorded,
        iterationCap: s.iterationCap, postGreenReviewK: s.postGreenReviewK,
        merged: finalStatus === "merged",
    };
}

// ── Scenarios ─────────────────────────────────────────────────────────────────────────────────────────

// THE core scenario: green on work 0 → review 1 clean, review 2 FLAGS → re-open into work 1 (drawing the
// remaining iterationCap), which goes green → the clean streak RESETS so a FULL K=2 fresh reviews run before
// merge. Sequence: work, review(clean), review(flag), work, review(clean), review(clean) → merged.
const flagReopensAndResets = (): ReopenScenario => ({ id: "flag-reopens-and-resets", iterationCap: 5, postGreenReviewK: 2, greenAt: [0, 1], reviewVerdicts: ["clean", "flag", "clean", "clean"] });

// Work-budget-exhausted mid-review: iterationCap=1, green on the only (== last) iteration; a review flags but
// there is no work budget left to re-fix → park needs-human.
const flagWithNoBudgetParks = (): ReopenScenario => ({ id: "flag-no-budget-parks", iterationCap: 1, postGreenReviewK: 2, greenAt: [0], reviewVerdicts: ["clean", "flag"] });

// Many re-opens, each drawing the SAME iterationCap budget: K=1, green on works 0/1/2; reviews flag, flag,
// clean → 3 work spawns (all within cap 5), the third review clean → merge.
const repeatedReopensDrawCap = (): ReopenScenario => ({ id: "repeated-reopens-draw-cap", iterationCap: 5, postGreenReviewK: 1, greenAt: [0, 1, 2], reviewVerdicts: ["flag", "flag", "clean"] });

// No flag at all: green → K=2 clean reviews → merge (the confirm-only happy path, preserved).
const cleanReviewsMerge = (): ReopenScenario => ({ id: "clean-reviews-merge", iterationCap: 5, postGreenReviewK: 2, greenAt: [0], reviewVerdicts: ["clean", "clean"] });

// A review that fails to COMPLETE still parks (unconfirmed), unchanged: K=3, pass 2 exits non-zero.
const reviewFailureParks = (): ReopenScenario => ({ id: "review-failure-parks", iterationCap: 5, postGreenReviewK: 3, greenAt: [0], reviewVerdicts: ["clean", "fail"] });

const POSITIVE_SCENARIOS: (() => ReopenScenario)[] = [
    flagReopensAndResets, flagWithNoBudgetParks, repeatedReopensDrawCap, cleanReviewsMerge, reviewFailureParks,
];

// ── The invariants ────────────────────────────────────────────────────────────────────────────────────

// reopens-draw-iteration-cap (probe target b): every work spawn — including re-opens — is bounded by the SAME
// iterationCap. A re-open that drew from a separate infinite budget would spawn more work than the cap allows.
function reopensDrawIterationCap(r: ReopenRecording): true | string {
    const work = workSpawnsOf(r);
    return work <= r.iterationCap
        || `${work} work spawns but iterationCap=${r.iterationCap} — a re-open drew from a separate budget instead of iterationCap`;
}

// reviews-do-not-consume-iteration-cap: the addIteration seam counts WORK iterations only — a review pass is
// never recorded as an iteration. Re-derives the work count from the ordered spawn seam.
function reviewsDoNotConsumeIterationCap(r: ReopenRecording): true | string {
    const work = workSpawnsOf(r);
    return r.iterationsRecorded === work
        || `iterationsRecorded=${r.iterationsRecorded} but ${work} work spawns — a review pass was miscounted against the iteration cap`;
}

// merge-requires-k-consecutive-clean (probe target a): a task that MERGES with K>0 did so on exactly K
// consecutive clean reviews immediately preceding the merge (the trailing review run). A re-fix that
// finalized WITHOUT re-earning K clean reviews leaves fewer than K trailing reviews.
function mergeRequiresKConsecutiveClean(r: ReopenRecording): true | string {
    if (!(r.merged && r.postGreenReviewK > 0)) return true;
    const trailing = trailingReviewsOf(r);
    return trailing === r.postGreenReviewK
        || `merged on ${trailing} trailing clean reviews but K=${r.postGreenReviewK} — finalized without re-earning K consecutive clean reviews`;
}

const INVARIANTS: Record<string, (r: ReopenRecording) => true | string> = {
    "reopens-draw-iteration-cap": reopensDrawIterationCap,
    "reviews-do-not-consume-iteration-cap": reviewsDoNotConsumeIterationCap,
    "merge-requires-k-consecutive-clean": mergeRequiresKConsecutiveClean,
};

// A predicate that THROWS becomes a failed check, never a silent pass.
function checkInvariants(r: ReopenRecording): Array<{ name: string; ok: boolean; detail?: string }> {
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
interface PositiveFixture { id: string; probe?: false; run: () => Promise<ReopenRecording> }
interface ProbeFixture { id: string; probe: true; recording: ReopenRecording; mustFail: string }
type ReopenFixture = PositiveFixture | ProbeFixture;

// A hand-crafted recording of the exact bug probe (a): a re-fix that finalized WITHOUT re-earning K clean
// reviews — a flag re-opened work, but the loop merged after only 1 clean review with K=2.
const finalizeWithoutReearningK: ReopenRecording = {
    unit: "review-reopen", finalStatus: "merged", terminalReason: null,
    spawnKinds: ["work", "review", "work", "review"], iterationsRecorded: 2,
    iterationCap: 5, postGreenReviewK: 2, merged: true,
};
// A hand-crafted recording of the exact bug probe (b): re-opens drew from a separate INFINITE budget — 3 work
// spawns against an iterationCap of 2.
const reopenDrawsInfiniteBudget: ReopenRecording = {
    unit: "review-reopen", finalStatus: "merged", terminalReason: null,
    spawnKinds: ["work", "review", "review", "work", "work", "review", "review"], iterationsRecorded: 3,
    iterationCap: 2, postGreenReviewK: 2, merged: true,
};

const FIXTURES: ReopenFixture[] = [
    ...POSITIVE_SCENARIOS.map((mk) => ({ id: mk().id, run: () => runReopenScenario(mk()) }) as PositiveFixture),
    { id: "finalize-without-reearning-k", probe: true, recording: finalizeWithoutReearningK, mustFail: "merge-requires-k-consecutive-clean" },
    { id: "reopen-draws-infinite-budget", probe: true, recording: reopenDrawsInfiniteBudget, mustFail: "reopens-draw-iteration-cap" },
];

type Verdict = "PASS" | "FAIL" | "BLOCKED";

// Positive → PASS iff every invariant holds against the REAL loop's recording; probe → PASS iff its named
// invariant FAILED (the harness caught the lie). BLOCKED (couldn't observe) is never a pass.
async function runFixture(f: ReopenFixture): Promise<{ verdict: Verdict; checks: Array<{ name: string; ok: boolean; detail?: string }> }> {
    let recording: ReopenRecording;
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

// ── Part 0: the review /goal frame is what tells a review spawn apart ──────────────────────────────────

describe("verify/review-reopen Part 0: the review-framed /goal carries the stable review frame", () => {
    it("buildReviewPrompt stamps the review frame; buildGoalPrompt (a work turn) does not", () => {
        const p = mkProject(), t = mkTask();
        expect(buildReviewPrompt(p, t)).toContain(REVIEW_MARKER);
        expect(buildGoalPrompt(p, t)).not.toContain(REVIEW_MARKER);
    });
});

// ── Part 1: re-open-on-finding in the REAL runTaskLoop ─────────────────────────────────────────────────

describe("verify/review-reopen Part 1: a review finding re-opens work; K-clean-to-finalize with reset", () => {
    it("a review that FLAGS re-opens work drawing iterationCap, and a re-green re-runs a FULL K reviews (reset)", async () => {
        const r = await runReopenScenario(flagReopensAndResets());
        expect(r.finalStatus).toBe("merged");
        // one work turn, K reviews (2nd flags), a re-fix work turn, then a FULL K fresh reviews → merge
        expect(r.spawnKinds).toEqual(["work", "review", "review", "work", "review", "review"]);
        expect(r.iterationsRecorded).toBe(2);          // two WORK iterations; the four reviews are NOT iterations
        expect(workSpawnsOf(r)).toBe(2);
        expect(workSpawnsOf(r)).toBeLessThanOrEqual(r.iterationCap);
        expect(trailingReviewsOf(r)).toBe(2);          // reset: a full K=2 clean reviews finalized, not 1
    });

    it("a flag with NO work budget left parks the task (review flagged, budget exhausted)", async () => {
        const r = await runReopenScenario(flagWithNoBudgetParks());
        expect(r.finalStatus).toBe("needs-human");
        expect(r.merged).toBe(false);
        expect(r.spawnKinds).toEqual(["work", "review", "review"]);
        expect(r.iterationsRecorded).toBe(1);          // the single work iteration (cap = 1) — reviews excluded
        expect(r.terminalReason).toContain("work budget exhausted");
    });

    it("repeated re-opens each draw the SAME iterationCap — total work spawns never exceed the cap", async () => {
        const r = await runReopenScenario(repeatedReopensDrawCap());
        expect(r.finalStatus).toBe("merged");
        expect(r.spawnKinds).toEqual(["work", "review", "work", "review", "work", "review"]);
        expect(workSpawnsOf(r)).toBe(3);
        expect(workSpawnsOf(r)).toBeLessThanOrEqual(r.iterationCap);
        expect(trailingReviewsOf(r)).toBe(1);          // K=1: the final clean review finalized
    });

    it("no flag → K consecutive clean reviews finalize immediately (confirm-only path preserved)", async () => {
        const r = await runReopenScenario(cleanReviewsMerge());
        expect(r.finalStatus).toBe("merged");
        expect(r.spawnKinds).toEqual(["work", "review", "review"]);
        expect(reviewSpawnsOf(r)).toBe(2);
    });

    it("a review that fails to complete parks the task (unconfirmed), unchanged", async () => {
        const r = await runReopenScenario(reviewFailureParks());
        expect(r.finalStatus).toBe("needs-human");
        expect(r.merged).toBe(false);
        expect(reviewSpawnsOf(r)).toBe(2);             // pass 1 clean, pass 2 failed → stop
        expect(r.terminalReason).toContain("post-green review pass 2/3");
    });
});

// ── Part 2: the CI matrix over every fixture ───────────────────────────────────────────────────────────

describe("verify/review-reopen Part 2: the CI matrix over every fixture", () => {
    it.each(FIXTURES.filter((f) => !f.probe).map((f) => [f.id, f] as const))(
        "honest fixture %s → PASS (the real loop respects re-open/reset/K-clean)",
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
        const garbage = null as unknown as ReopenRecording; // property access throws inside the predicates
        expect(checkInvariants(garbage).every((c) => !c.ok)).toBe(true);
    });
});
