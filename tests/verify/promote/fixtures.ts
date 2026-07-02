// tests/verify/promote/fixtures.ts
// Two kinds of fixture. POSITIVE fixtures drive the REAL runPromoteStage + finalizePromotion over a
// scenario — every invariant must hold. PROBES are hand-crafted BROKEN recordings (negative controls):
// each MUST FAIL its named invariant, proving the harness catches a lie and isn't just replaying happy
// paths. The roadmap's two required probes — pushes-target, ready-without-recheck — are here (plus a
// third for nothing-to-promote-detected).
import {
    runScenario, prReady, directReady, strictReady, nothingToPromote, conflictScenario, checkRed, acceptanceRed,
    PROMOTE_BRANCH, VALIDATED_SHA, type PromoteRecording,
} from "./surface";

export interface PositiveFixture { id: string; probe?: false; run: () => Promise<PromoteRecording> }
export interface ProbeFixture { id: string; probe: true; recording: PromoteRecording; mustFail: string }
export type PromoteFixture = PositiveFixture | ProbeFixture;

// A clean `direct` ready recording (all three invariants hold); each probe clones it and breaks ONE thing.
const BASELINE: PromoteRecording = {
    unit: "promote", mode: "direct", targetBranch: "main",
    outcome: "ready", validatedSha: VALIDATED_SHA, worktreeCreated: true, beyond: 3,
    checkGreen: true, acceptanceGreen: true,
    pushes: [{ localRef: PROMOTE_BRANCH, remoteRef: undefined }],
    pushedRefs: [PROMOTE_BRANCH],
    commands: [`git push origin ${VALIDATED_SHA}:refs/heads/main`],
};

export const PROMOTE_FIXTURES: PromoteFixture[] = [
    // ── Positive — the REAL stage over each scenario; every invariant must hold ─────────────────────
    { id: "pr-ready", run: () => runScenario(prReady()) },
    { id: "direct-ready", run: () => runScenario(directReady()) },
    { id: "strict-ready", run: () => runScenario(strictReady()) },
    { id: "nothing-to-promote", run: () => runScenario(nothingToPromote()) },
    { id: "conflict", run: () => runScenario(conflictScenario()) },
    { id: "recheck-failed-check", run: () => runScenario(checkRed()) },
    { id: "recheck-failed-acceptance", run: () => runScenario(acceptanceRed()) },

    // ── Probes — hand-crafted BROKEN recordings, each breaking ONE invariant ────────────────────────
    // The finalizer routed the target through pushBranch (the raw-sha→target push must be a PRINTED command,
    // never an engine push). MUST FAIL never-push-target.
    {
        id: "pushes-target", probe: true, mustFail: "never-push-target",
        recording: { ...BASELINE, pushes: [{ localRef: PROMOTE_BRANCH, remoteRef: "refs/heads/main" }] },
    },
    // A `ready` handed back despite a RED check — the re-check gate was skipped. MUST FAIL promote-recheck-before-ready.
    {
        id: "ready-without-recheck", probe: true, mustFail: "promote-recheck-before-ready",
        recording: { ...BASELINE, checkGreen: false },
    },
    // Nothing beyond the target, yet a worktree was built and it graduated. MUST FAIL nothing-to-promote-detected.
    {
        id: "worktree-built-with-nothing-to-promote", probe: true, mustFail: "nothing-to-promote-detected",
        recording: { ...BASELINE, beyond: 0 },
    },
];
