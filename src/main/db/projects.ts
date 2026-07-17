// src/main/db/projects.ts
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import type { Project, NewProjectInput } from "../../shared/types";

// The M3 config columns, in one place. Every absent value binds NULL — better-sqlite3 throws on
// `undefined`, and NULL is the meaningful "use the engine default / feature off" sentinel.
// tokenCap is STRUCTURAL (the resolveLoopConfig precedent): the column exists via db.ts's idempotent
// ensure, but shared/types' Project is pinned, so it's widened locally rather than picked off Project.
// postGreenReviewK is STRUCTURAL, the exact tokenCap precedent: the column exists via db.ts's idempotent
// ensure but shared/types' Project is pinned, so it's widened locally rather than picked off Project.
type ConfigField = "setupCommand" | "iterationCap" | "noProgressK" | "stallTimeoutMin" | "costCapUsd" | "model" | "concurrencyCap" | "terminalCommand" | "autoModeEnvironment" | "promotionMode" | "jailImage" | "tokenCap" | "postGreenReviewK";
const CONFIG_FIELDS: ConfigField[] = ["setupCommand", "iterationCap", "noProgressK", "stallTimeoutMin", "costCapUsd", "model", "concurrencyCap", "terminalCommand", "autoModeEnvironment", "promotionMode", "jailImage", "tokenCap", "postGreenReviewK"];
type ProjectConfig = Partial<Pick<Project, Exclude<ConfigField, "tokenCap" | "postGreenReviewK">>> & { tokenCap?: number | null; postGreenReviewK?: number | null };

export function insertProject(db: Db, input: NewProjectInput & { tokenCap?: number | null; postGreenReviewK?: number | null }): Project {
    // Trim every string input. A stray leading/trailing space (a paste artifact) in repoPath/
    // targetBranch silently bricks the project — `git -C " C:\\…"` fails with "cannot change to
    // ' C:\\…': Invalid argument" — and an optional field that's blank-after-trim means "unset".
    const opt = (s: string | null | undefined): string | null => { const t = s?.trim(); return t ? t : null; };
    const p: Project & { tokenCap: number | null; postGreenReviewK: number | null } = {
        id: randomUUID(),
        name: input.name.trim(),
        repoPath: input.repoPath.trim(),
        integrationBranch: "integration/ralph",
        targetBranch: input.targetBranch.trim(),
        branchPrefix: "ralph",
        checkCommand: input.checkCommand.trim(),
        worktreeDir: ".helm/worktrees",
        setupCommand: opt(input.setupCommand),
        iterationCap: input.iterationCap ?? null,
        noProgressK: input.noProgressK ?? null,
        stallTimeoutMin: input.stallTimeoutMin ?? null,
        costCapUsd: input.costCapUsd ?? null,
        tokenCap: input.tokenCap ?? null,
        postGreenReviewK: input.postGreenReviewK ?? null,
        model: opt(input.model),
        concurrencyCap: input.concurrencyCap ?? null,
        terminalCommand: opt(input.terminalCommand),
        autoModeEnvironment: opt(input.autoModeEnvironment),
        promotionMode: input.promotionMode ?? "pr", // NOT NULL — the safe default (nothing pushed to target)
        jailImage: opt(input.jailImage), // M13 — blank/absent → NULL → host mode
        conductorSessionId: null, // M16 — recorded only by a fresh conductor launch, never at registration
    };
    db.prepare(
        `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir,
                               setupCommand,iterationCap,noProgressK,stallTimeoutMin,costCapUsd,tokenCap,postGreenReviewK,model,concurrencyCap,terminalCommand,autoModeEnvironment,promotionMode,jailImage,conductorSessionId)
         VALUES (@id,@name,@repoPath,@integrationBranch,@targetBranch,@branchPrefix,@checkCommand,@worktreeDir,
                 @setupCommand,@iterationCap,@noProgressK,@stallTimeoutMin,@costCapUsd,@tokenCap,@postGreenReviewK,@model,@concurrencyCap,@terminalCommand,@autoModeEnvironment,@promotionMode,@jailImage,@conductorSessionId)`,
    ).run(p);
    return p;
}

// M16: record the conductor pane's claude session id for a project (a fresh launch overwrites the old
// one — one conductor conversation per project). NOT a config field — the launch path owns it, so it
// stays out of CONFIG_FIELDS/updateProject and the config form can never clobber it.
export function recordConductorSession(db: Db, id: string, sessionId: string | null): void {
    db.prepare("UPDATE projects SET conductorSessionId = ? WHERE id = ?").run(sessionId, id);
}

// Patch the editable config columns (the project-config form). Only the config fields are
// patchable; each named field binds NULL when absent so we never pass `undefined` to SQLite.
export function updateProject(db: Db, id: string, patch: ProjectConfig): void {
    const fields = CONFIG_FIELDS.filter((f) => f in patch);
    if (fields.length === 0) return;
    const set = fields.map((f) => `${f} = @${f}`).join(", ");
    const binds: Record<string, unknown> = { id };
    for (const f of fields) binds[f] = patch[f] ?? null;
    db.prepare(`UPDATE projects SET ${set} WHERE id = @id`).run(binds);
}

export function listProjects(db: Db): Project[] {
    return db.prepare("SELECT * FROM projects ORDER BY name").all() as Project[];
}

export function getProject(db: Db, id: string): Project | undefined {
    return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined;
}

// Delete a project and everything beneath it — its tasks, those tasks' iterations, and (M10) its plans —
// atomically. The tables carry no FK constraints (so no ON DELETE CASCADE); the cascade is therefore
// explicit and wrapped in a transaction, so a mid-delete crash can never leave orphaned rows pointing at a
// project that's already gone. Strictly scoped to this id — a second project's rows are never touched —
// and a harmless no-op (0 rows) for an unknown id. The projects:delete ipc notifies the board after.
export function deleteProject(db: Db, id: string): void {
    db.transaction(() => {
        db.prepare("DELETE FROM iterations WHERE taskId IN (SELECT id FROM tasks WHERE projectId = ?)").run(id);
        db.prepare("DELETE FROM tasks WHERE projectId = ?").run(id);
        db.prepare("DELETE FROM plans WHERE projectId = ?").run(id);
        db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    })();
}
