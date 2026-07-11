// src/main/db/failures.ts
// The M17 failure ledger's DB half. recordFailure/resolveFailures are called ONLY from tasks.updateTask
// (the single status-write chokepoint every needs-human/merged/abandoned write funnels through — that
// placement, not caller discipline, is the completeness guarantee); listFailures/summarizeFailures are
// the shared read fns both transports (the `helm failures` ctl verb today, a cockpit Health view later)
// call verbatim.
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import type { FailureNote, FailureRecord } from "../../shared/types";

// Append one OPEN row for a needs-human write. projectId is denormalized from the task row here (no
// join on the read paths); a missing task row means there is nothing to attribute the failure to, so
// the write is skipped (the tasks UPDATE it rides alongside no-ops on the same missing row). A caller
// that supplied no structured note still lands a row — kind 'unknown' is the structural default.
export function recordFailure(db: Db, taskId: string, reason: string, note?: FailureNote): void {
    const task = db.prepare("SELECT projectId FROM tasks WHERE id = ?").get(taskId) as { projectId: string } | undefined;
    if (!task) return;
    db.prepare(
        `INSERT INTO failures (id, taskId, projectId, kind, reason, iterationIndex, createdAt)
         VALUES (@id, @taskId, @projectId, @kind, @reason, @iterationIndex, @createdAt)`,
    ).run({
        id: randomUUID(),
        taskId,
        projectId: task.projectId,
        kind: note?.kind ?? "unknown",
        reason,
        iterationIndex: note?.iterationIndex ?? null,
        createdAt: Date.now(),
    });
}

// M18: the ledger insert for an in-place merge-loss recycle (the loop retried it itself — no
// needs-human write, so the updateTask chokepoint never sees it). The row lands ALREADY stamped
// 'recycled': it must never count as open (nothing waits on a human) and the terminal-outcome
// stamping below must never rewrite it (resolveFailures touches open rows only, by construction).
export function recordRecycledFailure(db: Db, taskId: string, reason: string, note: FailureNote): void {
    const task = db.prepare("SELECT projectId FROM tasks WHERE id = ?").get(taskId) as { projectId: string } | undefined;
    if (!task) return;
    const now = Date.now();
    db.prepare(
        `INSERT INTO failures (id, taskId, projectId, kind, reason, iterationIndex, createdAt, resolvedAt, resolution)
         VALUES (@id, @taskId, @projectId, @kind, @reason, @iterationIndex, @createdAt, @resolvedAt, 'recycled')`,
    ).run({
        id: randomUUID(),
        taskId,
        projectId: task.projectId,
        kind: note.kind,
        reason,
        iterationIndex: note.iterationIndex,
        createdAt: now,
        resolvedAt: now,
    });
}

// Stamp EVERY still-open row for the task on its terminal outcome (merged → 'resolved', abandoned →
// 'abandoned'). A task can hit needs-human several times across resume cycles → several rows; the v1
// rule stamps them all at the final outcome (ordering + iterationIndex approximate which one the human
// actually fixed). A requeue/resume in between is NOT terminal and stamps nothing — rows stay open.
export function resolveFailures(db: Db, taskId: string, resolution: "resolved" | "abandoned"): void {
    db.prepare("UPDATE failures SET resolvedAt = @now, resolution = @resolution WHERE taskId = @taskId AND resolvedAt IS NULL")
        .run({ now: Date.now(), resolution, taskId });
}

export interface FailureFilter {
    projectId?: string;  // absent = fleet-wide (the verb's --all)
    open?: boolean;      // true = unresolved rows only
    kind?: string;       // exact FailureKind match
    limit?: number;      // recent-rows cap (default 50, newest first)
}

const whereClause = (f: FailureFilter): { where: string; params: Record<string, unknown> } => {
    const conds: string[] = [];
    const params: Record<string, unknown> = {};
    if (f.projectId) { conds.push("projectId = @projectId"); params.projectId = f.projectId; }
    if (f.open) conds.push("resolvedAt IS NULL");
    if (f.kind) { conds.push("kind = @kind"); params.kind = f.kind; }
    return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
};

export function listFailures(db: Db, filter: FailureFilter = {}): FailureRecord[] {
    const { where, params } = whereClause(filter);
    return db.prepare(`SELECT * FROM failures ${where} ORDER BY createdAt DESC LIMIT @limit`)
        .all({ ...params, limit: filter.limit ?? 50 }) as FailureRecord[];
}

// The by-kind rollup the `helm failures` verb leads with: total + still-open per kind, biggest first.
export function summarizeFailures(db: Db, filter: FailureFilter = {}): Array<{ kind: string; total: number; open: number }> {
    const { where, params } = whereClause(filter);
    return db.prepare(
        `SELECT kind, COUNT(*) AS total, SUM(CASE WHEN resolvedAt IS NULL THEN 1 ELSE 0 END) AS open
         FROM failures ${where} GROUP BY kind ORDER BY total DESC, kind ASC`,
    ).all(params) as Array<{ kind: string; total: number; open: number }>;
}
