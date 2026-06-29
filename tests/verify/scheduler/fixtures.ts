// tests/verify/scheduler/fixtures.ts
// Two kinds of fixture. POSITIVE fixtures are scenarios driven through the REAL scheduler + mutex +
// runMergeStage (surface.runScenario) — every invariant must hold. PROBES are hand-crafted BROKEN
// recordings (negative controls): each MUST FAIL its named invariant, proving the harness catches a
// lie and isn't just replaying happy paths.
import type { Scenario, SchedulerRecording } from "./surface";
import { mkProject } from "./surface";

export interface PositiveFixture { id: string; probe?: false; scenario: Scenario }
export interface ProbeFixture { id: string; probe: true; recording: SchedulerRecording; mustFail: string }
export type SchedulerFixture = PositiveFixture | ProbeFixture;

const pass = (id: string, projectId: string): Scenario["tasks"][number] => ({ id, projectId, recheckPasses: true });

export const SCHEDULER_FIXTURES: SchedulerFixture[] = [
    // Two tasks go green simultaneously in one project → the mutex serializes their merges (one
    // interval at a time); both advance against the fresh tip in turn.
    { id: "two-simultaneous", scenario: { projects: [mkProject("p", 2)], tasks: [pass("a", "p"), pass("b", "p")] } },
    // A clean trio (cap 3) → all three merge in series, all advance.
    { id: "clean-trio", scenario: { projects: [mkProject("p", 3)], tasks: [pass("a", "p"), pass("b", "p"), pass("c", "p")] } },
    // Five queued under cap 3 → never more than 3 running; all five eventually merge in series.
    { id: "five-under-cap-3", scenario: { projects: [mkProject("p", 3)], tasks: [pass("a", "p"), pass("b", "p"), pass("c", "p"), pass("d", "p"), pass("e", "p")] } },
    // The headline rebase-on-tip catch: the loser's re-check against the winner's tip FAILS → it must
    // NOT advance (integration ends with only the winner). The winner advances; the loser → needs-human.
    { id: "winner-and-loser", scenario: { projects: [mkProject("p", 2)], tasks: [pass("win", "p"), { id: "lose", projectId: "p", recheckPasses: false }] } },

    // ── Probes — hand-crafted negative controls ──────────────────────────────────────────────────
    // Two merge intervals in one project that overlap in time.
    {
        id: "overlapping-merges", probe: true, mustFail: "at-most-one-merge-in-flight",
        recording: {
            unit: "scheduler", caps: { p: 3 }, maxRunningPerProject: { p: 2 },
            merges: [
                { taskId: "a", projectId: "p", enter: 1, exit: 4, recheckPassed: true, recheckRanBeforeAdvance: true, advanced: true },
                { taskId: "b", projectId: "p", enter: 2, exit: 5, recheckPassed: true, recheckRanBeforeAdvance: true, advanced: true },
            ],
        },
    },
    // Peak running exceeds the project cap.
    {
        id: "over-cap", probe: true, mustFail: "running-count-within-cap",
        recording: {
            unit: "scheduler", caps: { p: 3 }, maxRunningPerProject: { p: 4 },
            merges: [{ taskId: "a", projectId: "p", enter: 1, exit: 2, recheckPassed: true, recheckRanBeforeAdvance: true, advanced: true }],
        },
    },
    // A merge that advanced integration WITHOUT a passing re-check.
    {
        id: "advance-without-recheck", probe: true, mustFail: "rebase-on-tip-then-recheck",
        recording: {
            unit: "scheduler", caps: { p: 3 }, maxRunningPerProject: { p: 1 },
            merges: [{ taskId: "a", projectId: "p", enter: 1, exit: 2, recheckPassed: false, recheckRanBeforeAdvance: false, advanced: true }],
        },
    },
];
