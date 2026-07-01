// src/main/db/iterations.ts
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import type { Iteration } from "../../shared/types";

interface Row {
    id: string; taskId: string; idx: number; sessionId: string | null;
    startedAt: number; endedAt: number | null; gateVerdict: Iteration["gateVerdict"];
    commitSha: string | null; outputTail: string | null;
    inputTokens: number | null; outputTokens: number | null;
    cacheReadTokens: number | null; cacheCreationTokens: number | null;
    costUsd: number | null; durationMs: number | null;
}
const toIteration = (r: Row): Iteration => ({
    id: r.id, taskId: r.taskId, index: r.idx, sessionId: r.sessionId,
    startedAt: r.startedAt, endedAt: r.endedAt, gateVerdict: r.gateVerdict,
    commitSha: r.commitSha, outputTail: r.outputTail,
    inputTokens: r.inputTokens, outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens, cacheCreationTokens: r.cacheCreationTokens,
    costUsd: r.costUsd, durationMs: r.durationMs,
});

// The durable per-iteration accounting fields finishIteration may patch (besides verdict/sha/etc.).
type TokenPatch = Pick<Iteration, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens" | "costUsd" | "durationMs">;
export type FinishPatch = Partial<Pick<Iteration, "gateVerdict" | "commitSha" | "outputTail" | "sessionId"> & TokenPatch>;

export function addIteration(db: Db, taskId: string, index: number): Iteration {
    const it: Iteration = {
        id: randomUUID(), taskId, index, sessionId: null, startedAt: Date.now(), endedAt: null,
        gateVerdict: null, commitSha: null, outputTail: null,
        inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
        costUsd: null, durationMs: null,
    };
    db.prepare(`INSERT INTO iterations (id,taskId,idx,sessionId,startedAt,endedAt,gateVerdict,commitSha,outputTail)
                VALUES (@id,@taskId,@idx,@sessionId,@startedAt,@endedAt,@gateVerdict,@commitSha,@outputTail)`)
        .run({ ...it, idx: index });
    return it;
}

// Patch the row, always stamping endedAt. Each present field binds its value coalesced to NULL —
// better-sqlite3 throws on `undefined`, and an omitted token field must simply stay NULL.
export function finishIteration(db: Db, id: string, patch: FinishPatch): void {
    const fields = Object.keys(patch);
    const set = [...fields.map((f) => `${f} = @${f}`), "endedAt = @endedAt"].join(", ");
    const binds: Record<string, unknown> = { id, endedAt: Date.now() };
    for (const f of fields) binds[f] = (patch as Record<string, unknown>)[f] ?? null;
    db.prepare(`UPDATE iterations SET ${set} WHERE id = @id`).run(binds);
}

export function listIterations(db: Db, taskId: string): Iteration[] {
    return (db.prepare("SELECT * FROM iterations WHERE taskId = ? ORDER BY idx").all(taskId) as Row[]).map(toIteration);
}

// M5 drop-in resumes the FRESHEST *resumable* session: the sessionId of the highest-index iteration that
// recorded one. A sessionId is recorded ONLY for a turn that COMPLETED (agent ok → claude persisted its
// <id>.jsonl); a killed/stalled iteration records null (runIteration), so this never yields a session that
// `claude --resume` can't find. A null (killed) latest iteration does NOT shadow an earlier completed one.
// Pure (no DB) so the drop-in handler stays glue. null → no resumable session (Drop-in disabled).
export function latestSessionId(iterations: Iteration[]): string | null {
    let best: { index: number; sessionId: string } | null = null;
    for (const it of iterations) {
        if (it.sessionId != null && (best === null || it.index > best.index)) {
            best = { index: it.index, sessionId: it.sessionId };
        }
    }
    return best?.sessionId ?? null;
}
