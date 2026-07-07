// tests/verify/preflight/fixtures.ts
// Two kinds of fixture. POSITIVE fixtures drive the REAL runPreflight + approvalPermitted over a scenario — every
// invariant must hold. PROBES are hand-crafted BROKEN recordings (negative controls): each MUST FAIL its named
// invariant, proving the harness catches a lie and isn't a happy-path replay. One probe per declared invariant.
import { runScenario, allRed, mixedAllAcked, mixedNoneAcked, throwsMidRun, type PreflightRecording } from "./surface";

export interface PositiveFixture { id: string; probe?: false; run: () => Promise<PreflightRecording> }
export interface ProbeFixture { id: string; probe: true; recording: PreflightRecording; mustFail: string }
export type PreflightFixture = PositiveFixture | ProbeFixture;

// A clean baseline recording (all four invariants hold): one worktree built + removed, one faithful ok-red
// verdict, no warns, approved. Each probe clones it and breaks EXACTLY one thing.
const BASELINE: PreflightRecording = {
    unit: "preflight",
    ops: ["rev-parse", "create-worktree", "run:npm run verify:a", "remove-worktree"],
    worktreeCreated: true, worktreeRemoved: true, threw: false,
    verdicts: [{ command: "npm run verify:a", level: "ok-red", code: 1, timedOut: false, staticWarn: false }],
    acks: [], approved: true,
};

export const PREFLIGHT_FIXTURES: PreflightFixture[] = [
    // ── Positive — the REAL stage + decision over each scenario; every invariant must hold ──────────────
    { id: "all-red", run: () => runScenario(allRed()) },
    { id: "mixed-all-acked", run: () => runScenario(mixedAllAcked()) },
    { id: "mixed-none-acked", run: () => runScenario(mixedNoneAcked()) }, // refused approval — still invariant-clean
    { id: "throws-mid-run", run: () => runScenario(throwsMidRun()) },     // cleanup-on-throw

    // ── Probes — hand-crafted BROKEN recordings, each breaking ONE invariant ────────────────────────────
    // A ref-advancing op leaked into the recorded surface. MUST FAIL preflight-never-advances-refs.
    {
        id: "advances-a-ref", probe: true, mustFail: "preflight-never-advances-refs",
        recording: { ...BASELINE, ops: [...BASELINE.ops, "advance-branch:integration/ralph"] },
    },
    // An exit-0 command classified ok-red (it actually already passes). MUST FAIL verdict-classification-faithful.
    {
        id: "green-classified-red", probe: true, mustFail: "verdict-classification-faithful",
        recording: { ...BASELINE, verdicts: [{ command: "npm run check", level: "ok-red", code: 0, timedOut: false, staticWarn: false }] },
    },
    // A static-missing command classified ok-red (a missing script dressed up as a legit red). MUST FAIL it too.
    {
        id: "missing-classified-red", probe: true, mustFail: "verdict-classification-faithful",
        recording: { ...BASELINE, verdicts: [{ command: "npm run nope", level: "ok-red", code: 1, timedOut: false, staticWarn: true }] },
    },
    // Approved while a warn went unacked. MUST FAIL approve-requires-acks.
    {
        id: "approved-with-unacked-warn", probe: true, mustFail: "approve-requires-acks",
        recording: { ...BASELINE, approved: true, acks: [], verdicts: [{ command: "npm run check", level: "warn-already-green", code: 0, timedOut: false, staticWarn: false }] },
    },
    // The throwaway worktree was created but never removed. MUST FAIL worktree-always-cleaned.
    {
        id: "leaked-worktree", probe: true, mustFail: "worktree-always-cleaned",
        recording: { ...BASELINE, worktreeCreated: true, worktreeRemoved: false, ops: ["rev-parse", "create-worktree", "run:npm run verify:a"] },
    },
];
