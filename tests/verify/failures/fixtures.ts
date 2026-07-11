// tests/verify/failures/fixtures.ts
// The POSITIVE fixture drives the REAL kernel (updateTask over a temp sqlite DB, runTaskLoop +
// runMergeStage into every headless wall, the real ctl dispatcher). PROBES are hand-crafted BROKEN
// recordings (negative controls): each MUST FAIL its named invariant, proving the harness catches a
// lie and isn't just replaying happy paths.
import { runFailuresScenario, BASELINE, type FailuresRecording } from "./surface";

export interface PositiveFixture { id: string; probe?: false; run: () => Promise<FailuresRecording> }
export interface ProbeFixture { id: string; probe: true; recording: FailuresRecording; mustFail: string }
export type FailuresFixture = PositiveFixture | ProbeFixture;

export const FAILURES_FIXTURES: FailuresFixture[] = [
    // The comprehensive real run: DB chokepoint + engine walls + merge stage + dispatcher.
    { id: "real-kernel", run: runFailuresScenario },

    // ── Probes — hand-crafted negative controls (the spec's own, one per invariant) ────────────────
    // A needs-human write that landed NO ledger row — the capture seam silently dropped a failure.
    {
        id: "needs-human-without-row", probe: true, mustFail: "ledger-append-on-every-needs-human",
        recording: { ...BASELINE, openRowsAfterWrites: BASELINE.needsHumanWrites - 1 },
    },
    // A merged task that left an open ledger row — resolution never stamped.
    {
        id: "merged-leaves-open-row", probe: true, mustFail: "resolution-stamped-on-terminal-success",
        recording: { ...BASELINE, merged: { open: 1, resolved: 0 } },
    },
    // The spec's own probe: a merge conflict logged as cost-cap.
    {
        id: "merge-conflict-logged-as-cost-cap", probe: true, mustFail: "kind-faithful",
        recording: { ...BASELINE, kinds: [{ site: "merge-conflict (real merge stage)", expected: "merge-conflict", recorded: "cost-cap" }] },
    },
    // A row cleared/absent after recovery — today's bug, regressed.
    {
        id: "row-cleared-after-recovery", probe: true, mustFail: "ledger-survives-recovery",
        recording: { ...BASELINE, recovery: { taskFailureReason: null, ledgerReason: null, ledgerResolution: null } },
    },
    // A writing `failures` verb — the read verb mutated the DB.
    {
        id: "writing-failures-verb", probe: true, mustFail: "failures-verb-is-readonly",
        recording: { ...BASELINE, dbChangedByVerb: true },
    },
];
