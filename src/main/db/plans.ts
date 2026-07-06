// src/main/db/plans.ts
// The M10 `plans` entity — the grouping layer above tasks and the durable home for a PRD's text (copied in
// at approve, since the .helm/plan/ dir is transient and cleared once the tasks are born). Follows the
// projects.ts idiom: plain prepared statements, ids assigned here. One active plan per project is a UI
// convention, not a DB constraint — history keeps every approved plan.
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import type { Plan } from "../../shared/types";

export interface NewPlanInput { projectId: string; title: string; prdText: string; }

// Insert one plan, assigning its id + createdAt here (the projects.ts idiom). Returns the stored row so the
// approve executor can stamp Task.planId with the fresh id inside the same transaction.
export function insertPlan(db: Db, input: NewPlanInput): Plan {
    const p: Plan = { id: randomUUID(), projectId: input.projectId, title: input.title, prdText: input.prdText, createdAt: Date.now() };
    db.prepare(
        `INSERT INTO plans (id,projectId,title,prdText,createdAt) VALUES (@id,@projectId,@title,@prdText,@createdAt)`,
    ).run(p);
    return p;
}

export function listPlans(db: Db, projectId: string): Plan[] {
    return db.prepare("SELECT * FROM plans WHERE projectId = ? ORDER BY createdAt DESC").all(projectId) as Plan[];
}

export function getPlan(db: Db, id: string): Plan | undefined {
    return db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as Plan | undefined;
}
