// tests/verify/deps/fixtures.ts
// Two kinds of fixture. POSITIVE fixtures are scenarios driven through the REAL scheduler + gate + derivation
// (surface.runScenario) — every invariant must hold. PROBES are hand-crafted BROKEN recordings (negative
// controls): each MUST FAIL its named invariant, proving the harness catches a lie and isn't a happy-path replay.
import type { Scenario, DepsRecording } from "./surface";

export interface PositiveFixture { id: string; probe?: false; scenario: Scenario }
export interface ProbeFixture { id: string; probe: true; recording: DepsRecording; mustFail: string }
export type DepsFixture = PositiveFixture | ProbeFixture;

export const DEPS_FIXTURES: DepsFixture[] = [
    // The headline: T2 depends on T1. T2 is held while T1 runs; on T1's MERGE, T2 auto-starts.
    { id: "gate-then-release", scenario: { cap: 3, tasks: [{ id: "T1" }, { id: "T2", dependsOn: ["T1"] }] } },
    // A serial chain under cap 1 — each link starts only after the prior one merges.
    { id: "chain-under-cap-1", scenario: { cap: 1, tasks: [{ id: "T1" }, { id: "T2", dependsOn: ["T1"] }, { id: "T3", dependsOn: ["T2"] }] } },
    // A needs-human parent (never starts) leaves the child STUCK-blocked — it never starts; the derivation
    // reports blocked with the parent in its waitingOn.
    { id: "stuck-parent-blocks", scenario: { cap: 3, tasks: [{ id: "P", initialStatus: "needs-human" }, { id: "C", dependsOn: ["P"] }] } },
    // A deleted (unknown) parent id does NOT wedge the child — it starts, and the derivation is unblocked.
    { id: "unknown-parent-satisfied", scenario: { cap: 3, tasks: [{ id: "C", dependsOn: ["ghost"] }] } },
    // No edges at all → the start order equals FIFO (createdAt) — byte-identical to M4.
    { id: "no-edges-fifo", scenario: { cap: 3, tasks: [{ id: "a" }, { id: "b" }, { id: "c" }] } },

    // ── Probes — hand-crafted negative controls, one per invariant ────────────────────────────────────
    // A start recorded while a parent was still running.
    {
        id: "child-started-while-parent-running", probe: true, mustFail: "no-start-before-deps-merged",
        recording: {
            unit: "deps", hasEdges: true, startOrder: ["T1", "T2"], fifoOrder: ["T1"],
            starts: [
                { taskId: "T1", parents: [] },
                { taskId: "T2", parents: [{ id: "T1", status: "running" }] },
            ],
            derivations: [],
        },
    },
    // A derived blocked=false while a parent is unmerged (the derivation lying).
    {
        id: "blocked-false-with-unmerged-parent", probe: true, mustFail: "blocked-derivation-correct",
        recording: {
            unit: "deps", hasEdges: true, startOrder: [], fifoOrder: [], starts: [],
            derivations: [{ taskId: "C", blocked: false, waitingOnIds: [], parents: [{ id: "P", status: "running" }] }],
        },
    },
    // A no-edges board whose start order diverges from FIFO.
    {
        id: "reordered-empty-deps", probe: true, mustFail: "empty-deps-byte-identical",
        recording: { unit: "deps", hasEdges: false, startOrder: ["b", "a"], fifoOrder: ["a", "b"], starts: [], derivations: [] },
    },
];
