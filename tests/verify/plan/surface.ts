// tests/verify/plan/surface.ts
// The M10 verify SURFACE. It drives the REAL approve decision core (approveFromTasksJson → parsePlanDraft +
// planApproval) over a tasks.json string and distills a flat PlanApprovalRecording the invariants read. The
// core is the thin-executor idiom: on a parse failure it yields NO inserts (the ipc's DB transaction never
// runs), which is exactly what approve-only-valid asserts. Probes are hand-crafted broken recordings (negative
// controls). Vocabulary from ~/.claude/verification.md.
import { approveFromTasksJson } from "../../../src/main/engine/planDraft";

// One would-be inserted task, reduced to the fields the invariants judge.
export interface TaskInsertRecord {
    id: string;
    slug: string;
    acceptance: string[];
    dependsOn: string[]; // resolved real ids
}
export interface PlanApprovalRecording {
    unit: "plan";
    parseOk: boolean;          // did the draft parse?
    planInserted: boolean;     // would a plan row be inserted? (only ever when parseOk)
    inserts: TaskInsertRecord[]; // the task inserts an approve would produce (empty when parse failed)
}

export interface PlanScenario { tasksJson: string; prdText?: string | null; }

// Deterministic id generator (id-1, id-2, …) so the recording is reproducible. The real ipc passes randomUUID.
export function runApproval(scenario: PlanScenario): PlanApprovalRecording {
    let n = 0;
    const genId = () => `id-${++n}`;
    const r = approveFromTasksJson(scenario.tasksJson, scenario.prdText ?? null, genId);
    if (!r.ok) return { unit: "plan", parseOk: false, planInserted: false, inserts: [] };
    return {
        unit: "plan", parseOk: true, planInserted: true,
        inserts: r.plan.inserts.map((i) => ({ id: i.id, slug: i.slug, acceptance: i.acceptance, dependsOn: i.dependsOn })),
    };
}
