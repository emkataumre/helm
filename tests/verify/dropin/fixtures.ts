// tests/verify/dropin/fixtures.ts
// Two kinds of fixture. POSITIVE fixtures drive the REAL scheduler + runTaskLoop drop-in transition +
// verifyAndMerge handback (surface.run*Scenario) — every invariant must hold. PROBES are hand-crafted
// BROKEN recordings (negative controls): each MUST FAIL its named invariant, proving the harness catches
// a lie and isn't just replaying happy paths.
import { runFreesSlotScenario, runNeedsHumanRetainedScenario, type DropinRecording } from "./surface";

export interface PositiveFixture { id: string; probe?: false; run: () => Promise<DropinRecording> }
export interface ProbeFixture { id: string; probe: true; recording: DropinRecording; mustFail: string }
export type DropinFixture = PositiveFixture | ProbeFixture;

// A clean baseline recording (all four invariants hold) — each probe clones it and flips ONE field.
const BASELINE: DropinRecording = {
    unit: "dropin", cap: 1, maxRunningPerProject: { P: 1 },
    slotFreedOnDropIn: true, handedOffEverStarted: false,
    commitAtEntryBoundary: true, everyHandbackPrecededByCommit: true,
    handedOffOrNeedsHumanWorktreeRetained: true, mergedOrAbandonedWorktreeRemoved: true,
    killedIterationRecordsNoResumableSession: true,
};

export const DROPIN_FIXTURES: DropinFixture[] = [
    // cap 1, two queued tasks → drop into the running one → it hands off, the waiter starts, then the
    // human's verify-&-merge lands it. Real units throughout.
    { id: "frees-slot-and-verify-merge", run: runFreesSlotScenario },
    // a budget-exhausted task → needs-human, worktree retained (the spec §12 lifecycle change).
    { id: "needs-human-retains-worktree", run: runNeedsHumanRetainedScenario },

    // ── Probes — hand-crafted negative controls ──────────────────────────────────────────────────
    // The handed-off task still counts as running and the waiter never starts.
    { id: "slot-not-freed", probe: true, mustFail: "drop-in-frees-a-slot", recording: { ...BASELINE, slotFreedOnDropIn: false } },
    // listQueued leaked a handed-off task → the scheduler auto-started it.
    { id: "handed-off-auto-started", probe: true, mustFail: "handed-off-is-an-explicit-pause-state", recording: { ...BASELINE, handedOffEverStarted: true } },
    // A handback reached the merge with no preceding commit (the human's edits would be lost).
    { id: "handback-without-commit", probe: true, mustFail: "commit-before-handback", recording: { ...BASELINE, everyHandbackPrecededByCommit: false } },
    // A handed-off task's worktree was removed (it must be retained for drop-in).
    { id: "handed-off-worktree-removed", probe: true, mustFail: "worktree-retained-while-handed-off/needs-human", recording: { ...BASELINE, handedOffOrNeedsHumanWorktreeRetained: false } },
    // A killed iteration was recorded WITH a sessionId → drop-in would --resume a session claude never persisted.
    { id: "killed-session-recorded-resumable", probe: true, mustFail: "killed-iteration-has-no-resumable-session", recording: { ...BASELINE, killedIterationRecordsNoResumableSession: false } },
];
