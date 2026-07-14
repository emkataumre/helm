// tests/verify/preflight/fixtures.ts
// Two kinds of fixture. POSITIVE fixtures drive the REAL runPreflight + approvalPermitted over a scenario — every
// invariant must hold. PROBES are hand-crafted BROKEN recordings (negative controls): each MUST FAIL its named
// invariant, proving the harness catches a lie and isn't a happy-path replay. One probe per declared invariant.
import { runScenario, allRed, mixedAllAcked, mixedNoneAcked, throwsMidRun, rolesHappy, proofFakeGreenAcked, regressionTipRed, noProofTask, blockedSetup, type PreflightRecording } from "./surface";

export interface PositiveFixture { id: string; probe?: false; run: () => Promise<PreflightRecording> }
export interface ProbeFixture { id: string; probe: true; recording: PreflightRecording; mustFail: string }
export type PreflightFixture = PositiveFixture | ProbeFixture;

// A clean baseline recording (every invariant holds): one worktree built + removed, one faithful ok-red
// verdict, no warns, approved. Each probe clones it and breaks EXACTLY one thing.
const BASELINE: PreflightRecording = {
    unit: "preflight",
    ops: ["ensure-branch", "rev-parse", "create-worktree", "run:npm run verify:a", "remove-worktree"],
    worktreeCreated: true, worktreeRemoved: true, threw: false,
    blocked: false, rolesDeclared: false, taskHasProof: false, noProofWarned: false,
    verdicts: [{ command: "npm run verify:a", level: "ok-red", code: 1, timedOut: false, staticWarn: false, role: null }],
    acks: [], approved: true,
};

export const PREFLIGHT_FIXTURES: PreflightFixture[] = [
    // ── Positive — the REAL stage + decision over each scenario; every invariant must hold ──────────────
    { id: "all-red", run: () => runScenario(allRed()) },
    { id: "mixed-all-acked", run: () => runScenario(mixedAllAcked()) },
    { id: "mixed-none-acked", run: () => runScenario(mixedNoneAcked()) }, // refused approval — still invariant-clean
    { id: "throws-mid-run", run: () => runScenario(throwsMidRun()) },     // cleanup-on-throw
    // Role-aware vocabulary (2026-07-14):
    { id: "roles-happy", run: () => runScenario(rolesHappy()) },              // zero warns, zero acks — the noise-collapse cure
    { id: "proof-fake-green-acked", run: () => runScenario(proofFakeGreenAcked()) }, // the ONE real warn, acked
    { id: "regression-tip-red", run: () => runScenario(regressionTipRed()) },  // warn-tip-red unacked → refused
    { id: "no-proof-task", run: () => runScenario(noProofTask()) },            // synthetic warn fires → refused
    { id: "blocked-setup", run: () => runScenario(blockedSetup()) },           // BLOCKED: nothing observed, refused

    // ── Probes — hand-crafted BROKEN recordings, each breaking ONE invariant ────────────────────────────
    // A ref-advancing op leaked into the recorded surface. MUST FAIL preflight-never-advances-refs.
    {
        id: "advances-a-ref", probe: true, mustFail: "preflight-never-advances-refs",
        recording: { ...BASELINE, ops: [...BASELINE.ops, "advance-branch:integration/ralph"] },
    },
    // An exit-0 command classified ok-red (it actually already passes). MUST FAIL verdict-classification-faithful.
    {
        id: "green-classified-red", probe: true, mustFail: "verdict-classification-faithful",
        recording: { ...BASELINE, verdicts: [{ command: "npm run check", level: "ok-red", code: 0, timedOut: false, staticWarn: false, role: null }] },
    },
    // A static-missing command classified ok-red (a missing script dressed up as a legit red). MUST FAIL it too.
    {
        id: "missing-classified-red", probe: true, mustFail: "verdict-classification-faithful",
        recording: { ...BASELINE, verdicts: [{ command: "npm run nope", level: "ok-red", code: 1, timedOut: false, staticWarn: true, role: null }] },
    },
    // Approved while a warn went unacked. MUST FAIL approve-requires-acks.
    {
        id: "approved-with-unacked-warn", probe: true, mustFail: "approve-requires-acks",
        recording: { ...BASELINE, approved: true, acks: [], verdicts: [{ command: "npm run check", level: "warn-already-green", code: 0, timedOut: false, staticWarn: false, role: null }] },
    },
    // The throwaway worktree was created but never removed. MUST FAIL worktree-always-cleaned.
    {
        id: "leaked-worktree", probe: true, mustFail: "worktree-always-cleaned",
        recording: { ...BASELINE, worktreeCreated: true, worktreeRemoved: false, ops: ["ensure-branch", "rev-parse", "create-worktree", "run:npm run verify:a"] },
    },
    // The integration tip was read WITHOUT ensuring the branch exists first (the pre-fix behaviour that hung
    // fresh projects — M10 acceptance). MUST FAIL integration-ensured-before-read.
    {
        id: "reads-tip-without-ensuring", probe: true, mustFail: "integration-ensured-before-read",
        recording: { ...BASELINE, ops: ["rev-parse", "create-worktree", "run:npm run verify:a", "remove-worktree"] },
    },
    // A green REGRESSION suite classified as an ackable warn (the pre-overhaul misread of a standing suite).
    // MUST FAIL verdict-classification-faithful under the role-aware table.
    {
        id: "regression-green-misclassified", probe: true, mustFail: "verdict-classification-faithful",
        recording: { ...BASELINE, approved: false, verdicts: [{ command: "npm run check", level: "warn-already-green", code: 0, timedOut: false, staticWarn: false, role: "regression" }] },
    },
    // A BLOCKED (setup-failed) run that was approved anyway. MUST FAIL blocked-never-approvable.
    {
        id: "approved-while-blocked", probe: true, mustFail: "blocked-never-approvable",
        recording: { ...BASELINE, blocked: true, verdicts: [], ops: ["ensure-branch", "rev-parse", "create-worktree", "setup", "remove-worktree"], approved: true },
    },
    // A role-tagged task with no proof command that raised NO synthetic warn. MUST FAIL no-proof-warn-fires.
    {
        id: "no-proof-silent", probe: true, mustFail: "no-proof-warn-fires",
        recording: { ...BASELINE, rolesDeclared: true, taskHasProof: false, noProofWarned: false, verdicts: [{ command: "npm run check", level: "ok-pass", code: 0, timedOut: false, staticWarn: false, role: "regression" }] },
    },
];
