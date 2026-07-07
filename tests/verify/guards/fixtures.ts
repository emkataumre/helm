// tests/verify/guards/fixtures.ts
// Two kinds of fixture. POSITIVE fixtures drive the REAL runTaskLoop over a scenario — every invariant must
// hold. PROBES are hand-crafted BROKEN recordings (negative controls): each MUST FAIL its named invariant,
// proving the harness catches a lie and isn't a happy-path replay. One probe per declared invariant.
import { runScenario, pureWall, adaptedRecovers, distinctKeys, noProgressCourtesy, denyWallWinsTie, WALL, type GuardsRecording } from "./surface";

export interface PositiveFixture { id: string; probe?: false; run: () => Promise<GuardsRecording> }
export interface ProbeFixture { id: string; probe: true; recording: GuardsRecording; mustFail: string }
export type GuardFixture = PositiveFixture | ProbeFixture;

export const GUARD_FIXTURES: GuardFixture[] = [
    // ── Positive — the REAL loop over each scenario; every invariant must hold ───────────────────────────
    { id: "pure-wall-escalates", run: () => runScenario(pureWall()) },        // escalates at denyWallK, before the cap
    { id: "adapted-deny-recovers", run: () => runScenario(adaptedRecovers()) }, // deny stops → merged, never escalates
    { id: "distinct-keys-no-wall", run: () => runScenario(distinctKeys()) },   // no key repeats → cap, no escalation
    { id: "no-progress-folds-deny", run: () => runScenario(noProgressCourtesy()) }, // no-progress wins, folds in the deny
    { id: "deny-wall-wins-tie", run: () => runScenario(denyWallWinsTie()) },   // both fire same iter → deny wall wins

    // ── Probes — hand-crafted BROKEN recordings, each breaking ONE invariant ─────────────────────────────
    // A loop that saw the SAME wall on every one of 8 iterations yet thrashed to the cap without escalating.
    // MUST FAIL deny-wall-escalates-early (the breaker was missed).
    {
        id: "thrash-to-cap", probe: true, mustFail: "deny-wall-escalates-early",
        recording: {
            unit: "guards", finalStatus: "needs-human", terminalReason: "iteration cap reached (8)",
            iterationsRun: 8, iterationCap: 8, noProgressK: 2, denyWallK: 3, escalatedDenyWall: false,
            perIterationDenied: Array.from({ length: 8 }, () => [WALL]),
        },
    },
    // A loop that escalated a deny wall even though the key was denied only twice consecutively (then a
    // DIFFERENT key) — the deny was recoverable. MUST FAIL recoverable-deny-not-escalated (a false alarm).
    {
        id: "adapted-deny-escalated", probe: true, mustFail: "recoverable-deny-not-escalated",
        recording: {
            unit: "guards", finalStatus: "needs-human", terminalReason: `deny wall: "${WALL}" denied on 3 consecutive iterations`,
            iterationsRun: 3, iterationCap: 8, noProgressK: 2, denyWallK: 3, escalatedDenyWall: true,
            perIterationDenied: [[WALL], [WALL], ["Bash:other"]],
        },
    },
];
