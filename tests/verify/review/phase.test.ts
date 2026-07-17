// tests/verify/review/phase.test.ts
// The post-green review phase (M19, confirm-only) verify slice, in two parts:
//   Part 1 — the BEHAVIOUR: driving the REAL runTaskLoop with fake deps, a first-green task runs exactly K
//   confirm-only review passes (each a fresh review-framed spawn through the chokepoint) BEFORE it merges;
//   K=0 → no reviews (byte-identical to the pre-review loop); a review spawn that fails to complete parks
//   the task instead of landing unconfirmed work.
//   Part 2 — the CI matrix over every fixture + the declared invariants and their must-FAIL probes.
//
// THE mandated probe: a task that goes green on its LAST work iteration STILL gets its full K review passes
// — the review phase draws its OWN budget, separate from iterationCap. A version that skips reviews once
// the iteration cap is spent MUST FAIL `reviews-run-even-at-iteration-cap`.
//
// Non-circularity: the recording's ground truth is the ORDERED spawn-kind sequence read at the spawn seam
// (a spawn is a "review" iff its prompt carries buildReviewPrompt's stable frame — a guard test pins that
// frame), and the addIteration seam is recorded SEPARATELY; the invariants re-derive the work/review counts
// from that ordered sequence rather than trusting any loop-internal counter. Self-contained in this one file
// (the spend/tokens.test.ts shape). Runs headless under `npm run check`, zero prod footprint.
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

// A scenario's scripted world: how big the work budget is, how many reviews to run, which work iteration
// goes green, and (optionally) which review pass fails to complete.
interface ReviewScenario {
    id: string;
    iterationCap: number;
    postGreenReviewK: number;
    greenAt: number;         // 0-based work iteration whose gate goes green; >= iterationCap → never green
    reviewFailAt?: number;   // 0-based review pass that exits non-zero (the "review couldn't confirm" park)
}

// The flat recording the invariants read.
interface ReviewRecording {
    unit: "post-green-review";
    finalStatus: TaskStatus;
    terminalReason: string | null;
    spawnKinds: SpawnKind[];       // ORDERED ground truth at the spawn seam (work vs review, in fire order)
    iterationsRecorded: number;    // addIteration calls — the work-iteration-only seam (reviews must NOT show here)
    iterationCap: number;
    postGreenReviewK: number;
    wentGreen: boolean;            // a work iteration's gate went green → the review phase ran
    greenAtLastIteration: boolean; // that green work iteration was the iterationCap-th (last permitted)
    merged: boolean;
}

const usage = (u: Partial<TokenTotals> = {}): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, ...u });
const workSpawnsOf = (r: ReviewRecording): number => r.spawnKinds.filter((k) => k === "work").length;
const reviewSpawnsOf = (r: ReviewRecording): number => r.spawnKinds.filter((k) => k === "review").length;

// Drive the REAL loop over a scenario and distil the recording.
async function runReviewScenario(s: ReviewScenario): Promise<ReviewRecording> {
    const config: LoopConfig = { ...TEST_CONFIG, iterationCap: s.iterationCap, postGreenReviewK: s.postGreenReviewK };
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
                const failed = s.reviewFailAt === reviewIdx;
                return { ok: !failed, output: failed ? "review crashed" : "reviewed", sessionId: `rev-${reviewIdx}`, stalled: false, usage: usage(), durationMs: null, deniedCommands: [] };
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
        // The gate goes green ONLY on the scripted work iteration; the review phase itself never re-runs
        // runCheck, so a green here fires exactly once per reached-green work iteration.
        runCheck: async () => { const green = workIdx === s.greenAt; return { green, timedOut: false, output: green ? "" : "check failed" }; },
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
    // The loop reaches greenAt whenever it's within the iteration budget (every prior iteration is a red
    // gate that simply continues — no wall is in reach). These are scenario ground truths, not loop counters.
    const wentGreen = s.greenAt >= 0 && s.greenAt < s.iterationCap;
    const greenAtLastIteration = wentGreen && s.greenAt === s.iterationCap - 1;
    return {
        unit: "post-green-review",
        finalStatus, terminalReason, spawnKinds, iterationsRecorded,
        iterationCap: s.iterationCap, postGreenReviewK: s.postGreenReviewK,
        wentGreen, greenAtLastIteration, merged: finalStatus === "merged",
    };
}

// ── Scenarios ─────────────────────────────────────────────────────────────────────────────────────────

// Green on the very first work iteration → 1 work spawn, then K=2 confirm-only reviews, then merge.
const greenEarlyRunsKReviews = (): ReviewScenario => ({ id: "green-early", iterationCap: 5, postGreenReviewK: 2, greenAt: 0 });

// THE mandated probe scenario, positive form: green on the LAST permitted work iteration (index cap-1) STILL
// runs its full K reviews before merging — the review budget is separate from iterationCap.
const greenAtLastIterationStillReviews = (): ReviewScenario => ({ id: "green-at-last", iterationCap: 3, postGreenReviewK: 2, greenAt: 2 });

// The tightest case: a single-iteration budget, green on that only (== last) iteration — reviews still run.
const singleIterationGreenStillReviews = (): ReviewScenario => ({ id: "single-iter-green", iterationCap: 1, postGreenReviewK: 2, greenAt: 0 });

// K=0 turns the phase off: green → merge immediately, zero review spawns (the pre-review loop, unchanged).
const kZeroSkipsReviews = (): ReviewScenario => ({ id: "k-zero", iterationCap: 5, postGreenReviewK: 0, greenAt: 0 });

// A review pass that fails to COMPLETE parks the task (the review couldn't confirm) instead of merging:
// K=3 but the 2nd review (index 1) exits non-zero → 2 review spawns, needs-human, not merged.
const reviewFailureParks = (): ReviewScenario => ({ id: "review-failure-parks", iterationCap: 5, postGreenReviewK: 3, greenAt: 0, reviewFailAt: 1 });

const POSITIVE_SCENARIOS: (() => ReviewScenario)[] = [
    greenEarlyRunsKReviews, greenAtLastIterationStillReviews, singleIterationGreenStillReviews, kZeroSkipsReviews, reviewFailureParks,
];

// ── The invariants ────────────────────────────────────────────────────────────────────────────────────

// reviews-do-not-consume-iteration-cap: the addIteration seam counts WORK iterations only — a review pass is
// never recorded as an iteration. Re-derives the work count from the ordered spawn seam, independent of the
// loop's own counters.
function reviewsDoNotConsumeIterationCap(r: ReviewRecording): true | string {
    const work = workSpawnsOf(r);
    return r.iterationsRecorded === work
        || `iterationsRecorded=${r.iterationsRecorded} but ${work} work spawns — a review pass was miscounted against the iteration cap`;
}

// reviews-are-a-post-green-suffix: reviews run only AFTER the green work turn and before the merge — no work
// spawn may follow a review. And when a green task actually MERGES with K>0, exactly K reviews ran first.
function reviewsAreAPostGreenSuffix(r: ReviewRecording): true | string {
    let sawReview = false;
    for (const k of r.spawnKinds) {
        if (k === "review") sawReview = true;
        else if (sawReview) return "a work spawn followed a review spawn — reviews must run only after the green work turn, before the merge";
    }
    if (r.merged && r.wentGreen && r.postGreenReviewK > 0) {
        const reviews = reviewSpawnsOf(r);
        if (reviews !== r.postGreenReviewK) return `merged after ${reviews} review passes but K=${r.postGreenReviewK} — the phase must run exactly K clean passes before landing`;
    }
    return true;
}

// reviews-run-even-at-iteration-cap (THE probe target): a task green on its last permitted work iteration
// that finalizes as merged STILL ran its full K review passes — the review budget is separate from
// iterationCap. A loop that skips reviews once the work budget is spent parks/merges with 0 reviews here.
function reviewsRunEvenAtIterationCap(r: ReviewRecording): true | string {
    if (!(r.greenAtLastIteration && r.merged)) return true; // only constrains the green-on-last-iteration merge
    const reviews = reviewSpawnsOf(r);
    return reviews === r.postGreenReviewK
        || `green on the last work iteration merged with only ${reviews} of ${r.postGreenReviewK} review passes — reviews were skipped once the iteration cap was spent`;
}

const INVARIANTS: Record<string, (r: ReviewRecording) => true | string> = {
    "reviews-do-not-consume-iteration-cap": reviewsDoNotConsumeIterationCap,
    "reviews-are-a-post-green-suffix": reviewsAreAPostGreenSuffix,
    "reviews-run-even-at-iteration-cap": reviewsRunEvenAtIterationCap,
};

// A predicate that THROWS becomes a failed check, never a silent pass.
function checkInvariants(r: ReviewRecording): Array<{ name: string; ok: boolean; detail?: string }> {
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
interface PositiveFixture { id: string; probe?: false; run: () => Promise<ReviewRecording> }
interface ProbeFixture { id: string; probe: true; recording: ReviewRecording; mustFail: string }
type ReviewFixture = PositiveFixture | ProbeFixture;

// A hand-crafted recording of the exact bug the probe exists to catch — green on the last iteration, merged,
// but zero reviews ran (the "skip reviews once the iteration cap is spent" implementation).
const skipReviewsAtCap: ReviewRecording = {
    unit: "post-green-review", finalStatus: "merged", terminalReason: null,
    spawnKinds: ["work", "work", "work"], iterationsRecorded: 3,
    iterationCap: 3, postGreenReviewK: 2, wentGreen: true, greenAtLastIteration: true, merged: true,
};
// A recording where a review pass was wrongly counted as an iteration (iterationsRecorded inflated by the
// reviews) — the "reviews eat the iteration cap" bug.
const reviewCountedAsIteration: ReviewRecording = {
    unit: "post-green-review", finalStatus: "merged", terminalReason: null,
    spawnKinds: ["work", "review", "review"], iterationsRecorded: 3,
    iterationCap: 5, postGreenReviewK: 2, wentGreen: true, greenAtLastIteration: false, merged: true,
};

const FIXTURES: ReviewFixture[] = [
    ...POSITIVE_SCENARIOS.map((mk) => ({ id: mk().id, run: () => runReviewScenario(mk()) }) as PositiveFixture),
    { id: "skip-reviews-at-cap", probe: true, recording: skipReviewsAtCap, mustFail: "reviews-run-even-at-iteration-cap" },
    { id: "review-counted-as-iteration", probe: true, recording: reviewCountedAsIteration, mustFail: "reviews-do-not-consume-iteration-cap" },
];

type Verdict = "PASS" | "FAIL" | "BLOCKED";

// Positive → PASS iff every invariant holds against the REAL loop's recording; probe → PASS iff its named
// invariant FAILED (the harness caught the lie). BLOCKED (couldn't observe) is never a pass.
async function runFixture(f: ReviewFixture): Promise<{ verdict: Verdict; checks: Array<{ name: string; ok: boolean; detail?: string }> }> {
    let recording: ReviewRecording;
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

describe("verify/review Part 0: the review-framed /goal carries the stable review frame", () => {
    it("buildReviewPrompt stamps the review frame; buildGoalPrompt (a work turn) does not", () => {
        const p = mkProject(), t = mkTask();
        expect(buildReviewPrompt(p, t)).toContain(REVIEW_MARKER);
        expect(buildGoalPrompt(p, t)).not.toContain(REVIEW_MARKER);
    });
});

// ── Part 1: the post-green review phase in the REAL runTaskLoop ─────────────────────────────────────────

describe("verify/review Part 1: the confirm-only post-green review phase in the REAL runTaskLoop", () => {
    it("a first-green task runs exactly K confirm-only reviews AFTER the green work turn, then merges", async () => {
        const r = await runReviewScenario(greenEarlyRunsKReviews());
        expect(r.finalStatus).toBe("merged");
        expect(r.spawnKinds).toEqual(["work", "review", "review"]); // one work turn, then K=2 reviews, in order
        expect(r.iterationsRecorded).toBe(1);                        // only the work turn is an iteration
        expect(reviewSpawnsOf(r)).toBe(2);
    });

    it("PROBE: green on the LAST work iteration STILL runs its full K reviews (reviews draw their own budget)", async () => {
        const r = await runReviewScenario(greenAtLastIterationStillReviews());
        expect(r.finalStatus).toBe("merged");
        expect(r.greenAtLastIteration).toBe(true);
        expect(workSpawnsOf(r)).toBe(3);                            // the work budget was fully spent (cap = 3)
        expect(r.iterationsRecorded).toBe(3);                       // 3 iterations recorded — reviews are NOT among them
        expect(reviewSpawnsOf(r)).toBe(2);                          // …yet the 2 reviews still ran
        expect(reviewsRunEvenAtIterationCap(r)).toBe(true);
    });

    it("a single-iteration budget, green on that only iteration, still gets its K reviews before merge", async () => {
        const r = await runReviewScenario(singleIterationGreenStillReviews());
        expect(r.finalStatus).toBe("merged");
        expect(r.spawnKinds).toEqual(["work", "review", "review"]);
        expect(r.iterationsRecorded).toBe(1);
    });

    it("K=0 turns the phase off — green merges immediately with zero review spawns", async () => {
        const r = await runReviewScenario(kZeroSkipsReviews());
        expect(r.finalStatus).toBe("merged");
        expect(reviewSpawnsOf(r)).toBe(0);
        expect(r.spawnKinds).toEqual(["work"]);
    });

    it("a review pass that fails to complete parks the task (unconfirmed) instead of merging", async () => {
        const r = await runReviewScenario(reviewFailureParks());
        expect(r.finalStatus).toBe("needs-human");
        expect(r.merged).toBe(false);
        expect(reviewSpawnsOf(r)).toBe(2);                          // pass 1 ok, pass 2 failed → stop
        expect(r.terminalReason).toContain("post-green review pass 2/3");
    });
});

// ── Part 2: the CI matrix over every fixture ───────────────────────────────────────────────────────────

describe("verify/review Part 2: the CI matrix over every fixture", () => {
    it.each(FIXTURES.filter((f) => !f.probe).map((f) => [f.id, f] as const))(
        "honest fixture %s → PASS (the real loop respects the review budget)",
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
        const garbage = null as unknown as ReviewRecording; // property access throws inside the predicates
        expect(checkInvariants(garbage).every((c) => !c.ok)).toBe(true);
    });
});
