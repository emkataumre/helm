// src/main/db/projects.ts
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import type { Project, NewProjectInput } from "../../shared/types";

// The M3 config columns, in one place. Every absent value binds NULL — better-sqlite3 throws on
// `undefined`, and NULL is the meaningful "use the engine default / feature off" sentinel.
type ConfigField = "setupCommand" | "iterationCap" | "noProgressK" | "stallTimeoutMin" | "model" | "concurrencyCap" | "terminalCommand" | "autoModeEnvironment";
const CONFIG_FIELDS: ConfigField[] = ["setupCommand", "iterationCap", "noProgressK", "stallTimeoutMin", "model", "concurrencyCap", "terminalCommand", "autoModeEnvironment"];

export function insertProject(db: Db, input: NewProjectInput): Project {
    // Trim every string input. A stray leading/trailing space (a paste artifact) in repoPath/
    // targetBranch silently bricks the project — `git -C " C:\\…"` fails with "cannot change to
    // ' C:\\…': Invalid argument" — and an optional field that's blank-after-trim means "unset".
    const opt = (s: string | null | undefined): string | null => { const t = s?.trim(); return t ? t : null; };
    const p: Project = {
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
        model: opt(input.model),
        concurrencyCap: input.concurrencyCap ?? null,
        terminalCommand: opt(input.terminalCommand),
        autoModeEnvironment: opt(input.autoModeEnvironment),
    };
    db.prepare(
        `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir,
                               setupCommand,iterationCap,noProgressK,stallTimeoutMin,model,concurrencyCap,terminalCommand,autoModeEnvironment)
         VALUES (@id,@name,@repoPath,@integrationBranch,@targetBranch,@branchPrefix,@checkCommand,@worktreeDir,
                 @setupCommand,@iterationCap,@noProgressK,@stallTimeoutMin,@model,@concurrencyCap,@terminalCommand,@autoModeEnvironment)`,
    ).run(p);
    return p;
}

// Patch the editable config columns (the project-config form). Only the config fields are
// patchable; each named field binds NULL when absent so we never pass `undefined` to SQLite.
export function updateProject(db: Db, id: string, patch: Partial<Pick<Project, ConfigField>>): void {
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
