// src/main/db/tasks.ts
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import type { Task, NewTaskInput, FailureNote } from "../../shared/types";
import { recordFailure, resolveFailures } from "./failures";

interface Row extends Omit<Task, "acceptance" | "dependsOn"> { acceptance: string; dependsOn: string | null; }

// A guarded JSON.parse for the dependsOn column: NULL/absent/garbage all collapse to [] (a corrupt edge
// list must never throw on read — a task with no *valid* parents is simply unblocked), keeping only strings.
function parseDependsOn(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const v: unknown = JSON.parse(raw);
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch { return []; }
}

function toTask(row: Row): Task {
    return { ...row, acceptance: JSON.parse(row.acceptance) as string[], dependsOn: parseDependsOn(row.dependsOn) };
}

export function insertTask(db: Db, input: NewTaskInput): Task {
    const now = Date.now();
    const t: Task = {
        id: randomUUID(),
        projectId: input.projectId,
        title: input.title,
        intent: input.intent,
        acceptance: input.acceptance,
        status: "queued",
        scopeHint: input.scopeHint ?? null,
        dependsOn: input.dependsOn ?? [],
        planId: null, // hand-made via the New-task form; an approved plan's tasks go through insertPlanTask
        branchName: null, worktreePath: null, diffstat: null, failureReason: null,
        createdAt: now, updatedAt: now,
    };
    db.prepare(
        `INSERT INTO tasks (id,projectId,title,intent,acceptance,status,scopeHint,dependsOn,branchName,worktreePath,diffstat,failureReason,createdAt,updatedAt)
         VALUES (@id,@projectId,@title,@intent,@acceptance,@status,@scopeHint,@dependsOn,@branchName,@worktreePath,@diffstat,@failureReason,@createdAt,@updatedAt)`,
    ).run({ ...t, acceptance: JSON.stringify(t.acceptance), dependsOn: t.dependsOn.length ? JSON.stringify(t.dependsOn) : null });
    return t;
}

// M10 approve path: insert one task born from an approved plan. Unlike insertTask (hand-made, id generated
// here, planId NULL), the id is PRE-ASSIGNED by planApproval (so a sibling's dependsOn could resolve to it),
// planId is stamped, and dependsOn already holds real task ids. status is "queued" like every fresh task; the
// M9 merged-gate then holds a child until its parents merge. The INSERT includes the planId column.
export function insertPlanTask(db: Db, spec: { id: string; projectId: string; planId: string; title: string; intent: string; acceptance: string[]; scopeHint: string | null; dependsOn: string[] }): Task {
    const now = Date.now();
    const t: Task = {
        id: spec.id, projectId: spec.projectId, title: spec.title, intent: spec.intent, acceptance: spec.acceptance,
        status: "queued", scopeHint: spec.scopeHint, dependsOn: spec.dependsOn, planId: spec.planId,
        branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt: now, updatedAt: now,
    };
    db.prepare(
        `INSERT INTO tasks (id,projectId,title,intent,acceptance,status,scopeHint,dependsOn,planId,branchName,worktreePath,diffstat,failureReason,createdAt,updatedAt)
         VALUES (@id,@projectId,@title,@intent,@acceptance,@status,@scopeHint,@dependsOn,@planId,@branchName,@worktreePath,@diffstat,@failureReason,@createdAt,@updatedAt)`,
    ).run({ ...t, acceptance: JSON.stringify(t.acceptance), dependsOn: t.dependsOn.length ? JSON.stringify(t.dependsOn) : null });
    return t;
}

export function getTask(db: Db, id: string): Task | undefined {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? toTask(row) : undefined;
}

export function listTasks(db: Db): Task[] {
    return (db.prepare("SELECT * FROM tasks ORDER BY createdAt DESC").all() as Row[]).map(toTask);
}

// M17: `failure` is the structured ledger note riding a needs-human write — NOT a tasks column. It
// MUST be peeled off before the SET clause is built from Object.keys (spreading it through would hit
// "no such column: failure" INSIDE the engine's terminal path — the merge-wedge class of bug).
export type TaskPatch = Partial<Pick<Task, "status" | "branchName" | "worktreePath" | "diffstat" | "failureReason">> & {
    failure?: FailureNote;
};

// The single status-write chokepoint — every needs-human/merged/abandoned write in the app funnels
// through here (the engine's setStatus deps, handback, AND the boot-reconcile's direct calls), so the
// M17 ledger capture lives here and completeness is structural: a needs-human write whose caller
// supplied no note still lands a row (kind 'unknown'); a terminal success stamps every open row.
export function updateTask(db: Db, id: string, patch: TaskPatch): void {
    const { failure, ...cols } = patch;
    const fields = Object.keys(cols);
    if (fields.length === 0) return;
    const set = fields.map((f) => `${f} = @${f}`).join(", ");
    db.prepare(`UPDATE tasks SET ${set}, updatedAt = @updatedAt WHERE id = @id`).run({ ...cols, id, updatedAt: Date.now() });
    if (cols.status === "needs-human") recordFailure(db, id, cols.failureReason ?? "", failure);
    else if (cols.status === "merged" || cols.status === "abandoned") resolveFailures(db, id, cols.status === "merged" ? "resolved" : "abandoned");
}

// M9: replace a task's dependency edges (the cockpit's Clear-dependencies affordance passes []). Serialized
// like insert: empty → stored NULL (byte-identical to a no-deps task). Kept separate from updateTask because
// dependsOn is the one column that stores JSON, not a raw scalar.
export function setDependsOn(db: Db, id: string, ids: string[]): void {
    db.prepare("UPDATE tasks SET dependsOn = @dependsOn, updatedAt = @updatedAt WHERE id = @id")
        .run({ dependsOn: ids.length ? JSON.stringify(ids) : null, id, updatedAt: Date.now() });
}
