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

// A clean `direct` ready recording (all invariants hold) — it advances the target to the validated sha,
// which is now the legitimate one-click behaviour. Each probe clones it and breaks ONE thing.
const BASELINE: PromoteRecording = {
    unit: "promote", mode: "direct", targetBranch: "main",
    outcome: "ready", validatedSha: VALIDATED_SHA, worktreeCreated: true, beyond: 3,
    checkGreen: true, acceptanceGreen: true,
    pushes: [{ localRef: VALIDATED_SHA, remoteRef: "refs/heads/main" }], // direct advances the target to the validated sha
    pushedRefs: [],
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
    // Direct advanced the target to a BRANCH (not the re-validated sha) — the advance isn't faithful to the
    // re-check. MUST FAIL target-advance-is-validated.
    {
        id: "advances-unvalidated-ref", probe: true, mustFail: "target-advance-is-validated",
        recording: { ...BASELINE, pushes: [{ localRef: PROMOTE_BRANCH, remoteRef: "refs/heads/main" }] },
    },
    // pr mode pushed the TARGET ref — only direct may ever touch the target. MUST FAIL target-advance-is-validated.
    {
        id: "pr-pushes-target", probe: true, mustFail: "target-advance-is-validated",
        recording: { ...BASELINE, mode: "pr", pushes: [{ localRef: "integration/ralph", remoteRef: "refs/heads/main" }] },
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
