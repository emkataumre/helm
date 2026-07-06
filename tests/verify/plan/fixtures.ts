// tests/verify/plan/fixtures.ts
// POSITIVE fixtures are tasks.json strings driven through the REAL approve core (surface.runApproval) — every
// invariant must hold. PROBES are hand-crafted BROKEN recordings (negative controls): each MUST FAIL its named
// invariant, proving the harness catches a lie and isn't a happy-path replay.
import type { PlanScenario, PlanApprovalRecording } from "./surface";

export interface PositiveFixture { id: string; probe?: false; scenario: PlanScenario }
export interface ProbeFixture { id: string; probe: true; recording: PlanApprovalRecording; mustFail: string }
export type PlanFixture = PositiveFixture | ProbeFixture;

const json = (tasks: unknown[], planTitle = "p") => JSON.stringify({ planTitle, tasks });

export const PLAN_FIXTURES: PlanFixture[] = [
    // A valid single task → one insert, acceptance preserved, no edges.
    { id: "single-valid", scenario: { tasksJson: json([{ slug: "t1", title: "T", intent: "i", acceptance: ["npm run check"] }]) } },
    // A valid DAG → topo order, the child's edge resolved to the parent's id.
    { id: "valid-dag", scenario: { tasksJson: json([
        { slug: "t1", title: "A", intent: "i", acceptance: ["x"] },
        { slug: "t2", title: "B", intent: "i", acceptance: ["y"], dependsOn: ["t1"] },
    ]) } },
    // A diamond → t4 last, every edge points at an earlier real id.
    { id: "diamond", scenario: { tasksJson: json([
        { slug: "t1", title: "1", intent: "i", acceptance: ["x"] },
        { slug: "t2", title: "2", intent: "i", acceptance: ["x"], dependsOn: ["t1"] },
        { slug: "t3", title: "3", intent: "i", acceptance: ["x"], dependsOn: ["t1"] },
        { slug: "t4", title: "4", intent: "i", acceptance: ["x"], dependsOn: ["t2", "t3"] },
    ]) } },
    // A parse-invalid draft (missing acceptance) → the REAL core yields NO inserts (approve-only-valid holds).
    { id: "missing-acceptance-yields-nothing", scenario: { tasksJson: json([{ slug: "t1", title: "T", intent: "i", acceptance: [] }]) } },
    // A cyclic draft is rejected at parse → NO inserts (dep-slugs-resolve-acyclic holds vacuously).
    { id: "cycle-rejected-at-parse", scenario: { tasksJson: json([
        { slug: "a", title: "A", intent: "i", acceptance: ["x"], dependsOn: ["b"] },
        { slug: "b", title: "B", intent: "i", acceptance: ["x"], dependsOn: ["a"] },
    ]) } },
    // Non-JSON → parse fails → NO inserts.
    { id: "garbage-json-yields-nothing", scenario: { tasksJson: "{not json" } },

    // ── Probes — hand-crafted negative controls, one per invariant ────────────────────────────────────
    // Rows produced from a parse-invalid draft.
    {
        id: "rows-from-invalid-draft", probe: true, mustFail: "approve-only-valid",
        recording: { unit: "plan", parseOk: false, planInserted: true, inserts: [{ id: "id-1", slug: "t1", acceptance: ["x"], dependsOn: [] }] },
    },
    // A "parsed ok" cyclic insert set: A→B and B→A, so some edge must point forward (no valid topo order).
    {
        id: "cyclic-parsed-ok", probe: true, mustFail: "dep-slugs-resolve-acyclic",
        recording: { unit: "plan", parseOk: true, planInserted: true, inserts: [
            { id: "A", slug: "a", acceptance: ["x"], dependsOn: ["B"] },
            { id: "B", slug: "b", acceptance: ["x"], dependsOn: ["A"] },
        ] },
    },
    // An inserted task with an empty acceptance array.
    {
        id: "empty-acceptance-insert", probe: true, mustFail: "acceptance-mandatory-preserved",
        recording: { unit: "plan", parseOk: true, planInserted: true, inserts: [{ id: "id-1", slug: "t1", acceptance: [], dependsOn: [] }] },
    },
];
