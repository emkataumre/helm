// tests/verify/feedback/fixtures.ts
// The POSITIVE fixture drives the REAL kernel (runTaskLoop with recording fakes; the ledger drive
// adds the real DB behind the ipc wiring shape). PROBES are hand-crafted BROKEN recordings (negative
// controls): each MUST FAIL its named invariant, proving the harness catches a lie and isn't just
// replaying happy paths.
import { runFeedbackScenario, BASELINE, type FeedbackRecording } from "./surface";

export interface PositiveFixture { id: string; probe?: false; run: () => Promise<FeedbackRecording> }
export interface ProbeFixture { id: string; probe: true; recording: FeedbackRecording; mustFail: string }
export type FeedbackFixture = PositiveFixture | ProbeFixture;

export const FEEDBACK_FIXTURES: FeedbackFixture[] = [
    // The comprehensive real run: recycle + bound + non-recyclable park + real-DB ledger + resume seed.
    { id: "real-kernel", run: runFeedbackScenario },

    // ── Probes — hand-crafted negative controls (the spec's own, one per invariant) ────────────────
    // Pre-M18 behaviour: the first conflict parks at needs-human instead of recycling.
    {
        id: "parks-on-first-conflict", probe: true, mustFail: "merge-loss-recycles-not-parks",
        recording: { ...BASELINE, conflict: { finalStatus: "needs-human", needsHumanWrites: 1, spawnPrompts: 1, retryPromptHasCause: false, retryPromptDemandsMerge: false } },
    },
    // An unbounded recycler: attempts keep climbing past mergeRecycleK + 1.
    {
        id: "unbounded-recycler", probe: true, mustFail: "recycle-bounded",
        recording: { ...BASELINE, bounded: { ...BASELINE.bounded, mergeAttempts: 9 } },
    },
    // A recycled merge-SETUP failure: a config fault the agent can't fix was fed back anyway.
    {
        id: "recycled-setup-failure", probe: true, mustFail: "non-recyclable-kinds-still-park",
        recording: { ...BASELINE, nonRecyclable: { finalStatus: "merged", mergeAttempts: 2, recycles: 1 } },
    },
    // An invisible recycle: the loss was fed back but no ledger row landed — the M17 data vanished.
    {
        id: "invisible-recycle", probe: true, mustFail: "recycled-losses-still-ledgered",
        recording: { ...BASELINE, ledger: { ...BASELINE.ledger, recycledRows: 0, recycledKinds: [], resolutions: [] } },
    },
    // An uninformed resume: the parked reason never reached the resumed agent's first prompt.
    {
        id: "uninformed-resume", probe: true, mustFail: "resume-carries-parked-cause",
        recording: { ...BASELINE, resume: { parkedPromptHasCause: false, cleanPromptSeeded: false } },
    },
];
