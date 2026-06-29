// src/main/db/tasks.ts
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import type { Task, NewTaskInput } from "../../shared/types";

interface Row extends Omit<Task, "acceptance"> { acceptance: string; }

function toTask(row: Row): Task {
    return { ...row, acceptance: JSON.parse(row.acceptance) as string[] };
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
        branchName: null, worktreePath: null, diffstat: null, failureReason: null,
        createdAt: now, updatedAt: now,
    };
    db.prepare(
        `INSERT INTO tasks (id,projectId,title,intent,acceptance,status,scopeHint,branchName,worktreePath,diffstat,failureReason,createdAt,updatedAt)
         VALUES (@id,@projectId,@title,@intent,@acceptance,@status,@scopeHint,@branchName,@worktreePath,@diffstat,@failureReason,@createdAt,@updatedAt)`,
    ).run({ ...t, acceptance: JSON.stringify(t.acceptance) });
    return t;
}

export function getTask(db: Db, id: string): Task | undefined {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? toTask(row) : undefined;
}

export function listTasks(db: Db): Task[] {
    return (db.prepare("SELECT * FROM tasks ORDER BY createdAt DESC").all() as Row[]).map(toTask);
}

export function updateTask(db: Db, id: string, patch: Partial<Pick<Task, "status" | "branchName" | "worktreePath" | "diffstat" | "failureReason">>): void {
    const fields = Object.keys(patch);
    if (fields.length === 0) return;
    const set = fields.map((f) => `${f} = @${f}`).join(", ");
    db.prepare(`UPDATE tasks SET ${set}, updatedAt = @updatedAt WHERE id = @id`).run({ ...patch, id, updatedAt: Date.now() });
}
