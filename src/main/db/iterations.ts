// src/main/db/iterations.ts
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import type { Iteration } from "../../shared/types";

interface Row { id: string; taskId: string; idx: number; sessionId: string | null; startedAt: number; endedAt: number | null; gateVerdict: Iteration["gateVerdict"]; commitSha: string | null; outputTail: string | null; }
const toIteration = (r: Row): Iteration => ({ id: r.id, taskId: r.taskId, index: r.idx, sessionId: r.sessionId, startedAt: r.startedAt, endedAt: r.endedAt, gateVerdict: r.gateVerdict, commitSha: r.commitSha, outputTail: r.outputTail });

export function addIteration(db: Db, taskId: string, index: number): Iteration {
    const it: Iteration = { id: randomUUID(), taskId, index, sessionId: null, startedAt: Date.now(), endedAt: null, gateVerdict: null, commitSha: null, outputTail: null };
    db.prepare(`INSERT INTO iterations (id,taskId,idx,sessionId,startedAt,endedAt,gateVerdict,commitSha,outputTail)
                VALUES (@id,@taskId,@idx,@sessionId,@startedAt,@endedAt,@gateVerdict,@commitSha,@outputTail)`)
        .run({ ...it, idx: index });
    return it;
}

export function finishIteration(db: Db, id: string, patch: Partial<Pick<Iteration, "gateVerdict" | "commitSha" | "outputTail" | "sessionId">>): void {
    const fields = Object.keys(patch);
    const set = [...fields.map((f) => `${f} = @${f}`), "endedAt = @endedAt"].join(", ");
    db.prepare(`UPDATE iterations SET ${set} WHERE id = @id`).run({ ...patch, id, endedAt: Date.now() });
}

export function listIterations(db: Db, taskId: string): Iteration[] {
    return (db.prepare("SELECT * FROM iterations WHERE taskId = ? ORDER BY idx").all(taskId) as Row[]).map(toIteration);
}
