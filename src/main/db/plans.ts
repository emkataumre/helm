// src/main/db/plans.ts
// The M10 `plans` entity — the grouping layer above tasks and the durable home for a PRD's text (copied in
// at approve, since the .helm/plan/ dir is transient and cleared once the tasks are born). Follows the
// projects.ts idiom: plain prepared statements, ids assigned here. One active plan per project is a UI
// convention, not a DB constraint — history keeps every approved plan.
// Plan-queue slice 2: each plan also carries its run-order slot (queuePos), an optional parent plan
// (dependsOnPlan) and a gate mode ('strict'|'yolo') — stamped at approve from the draft's publish metadata
// (planQueueMetaFromDraft below is the exact seam ipc.ts calls) and read back defensively.
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import type { Plan } from "../../shared/types";

// The plan-queue gate mode. Read defensively everywhere: anything that isn't exactly 'yolo' (a hand-edited
// row, a typo'd draft, a future value an older build doesn't know) reads as 'strict' — the safe mode.
export type GateMode = "strict" | "yolo";
export const asGateMode = (v: unknown): GateMode => (v === "yolo" ? "yolo" : "strict");

// The stored plan row: the shared Plan shape + the plan-queue columns (a superset, so every existing Plan
// consumer keeps working; the queue fields live main-side only until the renderer grows a queue view).
export interface PlanRow extends Plan {
    queuePos: number | null;
    dependsOnPlan: string | null;
    gateMode: GateMode;
}

export interface NewPlanInput {
    projectId: string; title: string; prdText: string;
    queuePos?: number | null; dependsOnPlan?: string | null; gateMode?: string | null;
}

// The approve-stamping seam: pull the plan-queue publish metadata off the RAW tasks.json — optional
// top-level fields (parsePlanDraft ignores unknown keys, so a draft carrying them still parses/approves).
// Defensive throughout: unparseable JSON, wrong types, a non-integer queuePos or a blank dependsOnPlan all
// fall to the safe defaults (null order, null parent, 'strict' gate) rather than wedging the approve.
export function planQueueMetaFromDraft(tasksJson: string): { queuePos: number | null; dependsOnPlan: string | null; gateMode: GateMode } {
    try {
        const obj = JSON.parse(tasksJson) as Record<string, unknown>;
        return {
            queuePos: typeof obj.queuePos === "number" && Number.isInteger(obj.queuePos) ? obj.queuePos : null,
            dependsOnPlan: typeof obj.dependsOnPlan === "string" && obj.dependsOnPlan.trim() !== "" ? obj.dependsOnPlan.trim() : null,
            gateMode: asGateMode(obj.gateMode),
        };
    } catch {
        return { queuePos: null, dependsOnPlan: null, gateMode: "strict" };
    }
}

// Insert one plan, assigning its id + createdAt here (the projects.ts idiom). Returns the stored row so the
// approve executor can stamp Task.planId with the fresh id inside the same transaction. The queue fields are
// optional (a caller without publish metadata gets the safe defaults); gateMode is normalized on the way IN
// too, so a bad value never even reaches the row.
export function insertPlan(db: Db, input: NewPlanInput): PlanRow {
    const p: PlanRow = {
        id: randomUUID(), projectId: input.projectId, title: input.title, prdText: input.prdText, createdAt: Date.now(),
        queuePos: input.queuePos ?? null, dependsOnPlan: input.dependsOnPlan ?? null, gateMode: asGateMode(input.gateMode),
    };
    db.prepare(
        `INSERT INTO plans (id,projectId,title,prdText,createdAt,queuePos,dependsOnPlan,gateMode)
         VALUES (@id,@projectId,@title,@prdText,@createdAt,@queuePos,@dependsOnPlan,@gateMode)`,
    ).run(p);
    return p;
}

// Reads normalize gateMode defensively (a hand-edited/garbage stored value reads as 'strict') so an unknown
// mode can never leak past this module.
const fromRow = (r: Record<string, unknown>): PlanRow => ({ ...(r as unknown as PlanRow), gateMode: asGateMode(r.gateMode) });

export function listPlans(db: Db, projectId: string): PlanRow[] {
    return (db.prepare("SELECT * FROM plans WHERE projectId = ? ORDER BY createdAt DESC").all(projectId) as Record<string, unknown>[]).map(fromRow);
}

export function getPlan(db: Db, id: string): PlanRow | undefined {
    const r = db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? fromRow(r) : undefined;
}
