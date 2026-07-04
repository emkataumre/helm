// PURE bits of the M8.5 accept harness — SQL assembly + path plumbing. Imports only node:path (no
// playwright, no better-sqlite3, no node-pty), so the NORMAL suite unit-tests it (tests/seed-sql.test.ts)
// while the impure harness (harness.ts) uses it to drive the real app. Deterministic (no Date.now here) so
// the assembled SQL is unit-testable; the impure harness passes real timestamps.
import { join } from "node:path";

// Mirror engine/worktree.ts sanitize(): the on-disk worktree dir name for a branch (slashes → dashes).
export function sanitizeBranch(branch: string): string {
    return branch.replace(/[^a-zA-Z0-9._-]/g, "-");
}

// Mirror engine/worktree.ts worktreePathFor(): <repo>/<worktreeDir>/<sanitized-branch>. Default worktreeDir
// matches the engine default (".helm/worktrees") so a seeded worktree lands exactly where boot-reconcile
// expects an owned, retained one — and is therefore never pruned.
export function retainedWorktreePath(repoDir: string, branch: string, worktreeDir = ".helm/worktrees"): string {
    return join(repoDir, worktreeDir, sanitizeBranch(branch));
}

// SQL string/number/NULL literal for the sqlite3 CLI. Single-quotes are doubled (SQLite's escaping) so a
// title/name with an apostrophe can't break the statement or inject.
function lit(v: string | number | null): string {
    if (v === null) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${v.replace(/'/g, "''")}'`;
}

export interface SeedProject {
    id: string;
    name: string;
    repoPath: string;
    targetBranch?: string;      // default "main"
    integrationBranch?: string; // default "integration/ralph"
    branchPrefix?: string;      // default "ralph"
    checkCommand?: string;      // default "npm run check" (never RUN in accept — no task spawns)
    worktreeDir?: string;       // default ".helm/worktrees" (matches the engine default)
}

// A step-0 projects INSERT (the base schema we seed; the app's migrate() adds the config columns on boot).
// Every column here is a step-0 column — the config/token columns arrive via the real ALTERs.
export function seedProjectSql(p: SeedProject): string {
    const vals = [
        p.id, p.name, p.repoPath,
        p.integrationBranch ?? "integration/ralph",
        p.targetBranch ?? "main",
        p.branchPrefix ?? "ralph",
        p.checkCommand ?? "npm run check",
        p.worktreeDir ?? ".helm/worktrees",
    ].map(lit).join(",");
    return `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir) VALUES (${vals});`;
}

export interface SeedTask {
    id: string;
    projectId: string;
    title: string;
    status: string;              // "needs-human" | "merged" | … (whatever lane the scenario needs)
    intent?: string;
    acceptance?: string[];       // stored as a JSON array (the M6-④ real-JSON lesson) — never a bare string
    branchName?: string | null;
    worktreePath?: string | null;
    createdAt?: number;
    updatedAt?: number;
}

// A step-0 tasks INSERT. acceptance is JSON-encoded exactly as insertTask does (db/tasks.ts), so the app
// reads it back with JSON.parse without choking. Deterministic default createdAt keeps the SQL unit-testable.
export function seedTaskSql(t: SeedTask): string {
    const now = t.createdAt ?? 1_700_000_000_000;
    const vals = [
        lit(t.id), lit(t.projectId), lit(t.title), lit(t.intent ?? "seeded by the M8.5 accept harness"),
        lit(JSON.stringify(t.acceptance ?? ["npm run check"])), lit(t.status),
        lit(t.branchName ?? null), lit(t.worktreePath ?? null), "NULL", "NULL",
        lit(now), lit(t.updatedAt ?? now),
    ].join(",");
    return `INSERT INTO tasks (id,projectId,title,intent,acceptance,status,branchName,worktreePath,diffstat,failureReason,createdAt,updatedAt) VALUES (${vals});`;
}

// The step-0 base schema (matches db.ts STEPS[0]) + user_version = 0. We seed the OLD-SHAPE DB and let the
// app's REAL migrate() carry it to head on boot — drift-proof (no config/token columns transcribed here) and
// it exercises the real migration (the M3 "migration round-trips old-shape data" invariant). If db.ts STEPS[0]
// ever changes, update this block; the later ALTERs need no mirror here.
export const BASE_SCHEMA_SQL = `PRAGMA user_version = 0;
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, repoPath TEXT NOT NULL,
    integrationBranch TEXT NOT NULL, targetBranch TEXT NOT NULL,
    branchPrefix TEXT NOT NULL, checkCommand TEXT NOT NULL, worktreeDir TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
    intent TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL,
    branchName TEXT, worktreePath TEXT, diffstat TEXT, failureReason TEXT,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS iterations (
    id TEXT PRIMARY KEY, taskId TEXT NOT NULL, idx INTEGER NOT NULL,
    sessionId TEXT, startedAt INTEGER NOT NULL, endedAt INTEGER,
    gateVerdict TEXT, commitSha TEXT, outputTail TEXT
);`;
