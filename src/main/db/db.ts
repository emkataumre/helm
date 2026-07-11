// src/main/db/db.ts
import Database from "better-sqlite3";

export type Db = Database.Database;

// Migrations-as-sole-authority. The ordered steps ARE the schema: step 0 is the base
// CREATE TABLE block, later steps ALTER it. A fresh DB and an existing M1/M2 DB both converge
// to the head shape with no second copy of the schema to drift. `user_version` is the cursor;
// each applied step advances it, so re-runs are no-ops. NEVER drop & recreate the dev DB —
// from M3 on, real iteration/token data is worth keeping.
const STEPS: Array<(db: Db) => void> = [
    // Step 0 — the base tables (today's M1/M2 schema). IF NOT EXISTS so an existing DB is a no-op.
    (db) => db.exec(`
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
        );
    `),
    // Step 1 — per-project config + per-task scope hint. All nullable (NULL = "use engine default
    // / feature off"). stallTimeoutMin is MINUTES (the units seam; converted to ms in resolveLoopConfig).
    (db) => {
        db.exec(`ALTER TABLE projects ADD COLUMN setupCommand TEXT`);
        db.exec(`ALTER TABLE projects ADD COLUMN iterationCap INTEGER`);
        db.exec(`ALTER TABLE projects ADD COLUMN noProgressK INTEGER`);
        db.exec(`ALTER TABLE projects ADD COLUMN stallTimeoutMin INTEGER`);
        db.exec(`ALTER TABLE projects ADD COLUMN model TEXT`);
        db.exec(`ALTER TABLE tasks ADD COLUMN scopeHint TEXT`);
    },
    // Step 2 — per-iteration token accounting + duration. All nullable (absent = not recorded).
    (db) => {
        db.exec(`ALTER TABLE iterations ADD COLUMN inputTokens INTEGER`);
        db.exec(`ALTER TABLE iterations ADD COLUMN outputTokens INTEGER`);
        db.exec(`ALTER TABLE iterations ADD COLUMN cacheReadTokens INTEGER`);
        db.exec(`ALTER TABLE iterations ADD COLUMN cacheCreationTokens INTEGER`);
        db.exec(`ALTER TABLE iterations ADD COLUMN costUsd REAL`);
        db.exec(`ALTER TABLE iterations ADD COLUMN durationMs INTEGER`);
    },
    // Step 3 — M4 per-project scheduler cap (nullable; NULL = engine default 3). A *scheduler* bound,
    // not a LoopConfig field, so it's read straight off the project (project.concurrencyCap ?? 3).
    (db) => {
        db.exec(`ALTER TABLE projects ADD COLUMN concurrencyCap INTEGER`);
    },
    // Step 4 — M5 per-project drop-in terminal-launch template (nullable; NULL = the engine default
    // constant `wt.exe -d "{worktree}" claude {resume}`). Read straight off the project at launch time.
    (db) => {
        db.exec(`ALTER TABLE projects ADD COLUMN terminalCommand TEXT`);
    },
    // Step 5 — M6-② per-project auto-mode trusted environment (spec §10; nullable, NULL = engine
    // default ["$defaults"]). Stored raw as TEXT (the confirmed Task-1 shape: NL trust line(s) or a
    // JSON array); buildSpawnSettings composes the `autoMode.environment` array from it per spawn.
    (db) => {
        db.exec(`ALTER TABLE projects ADD COLUMN autoModeEnvironment TEXT`);
    },
    // Step 6 — M6-③ per-project promotion strategy for the project-level batch Promote (spec §13/§3):
    // 'pr' (push integration + hand a `gh pr create` command), 'direct' (push the validated promote
    // branch + hand a raw-sha push to targetBranch), or 'strict' (push nothing; hand the full local
    // sequence). NOT NULL DEFAULT 'pr' — the first non-nullable config column, so the ALTER backfills
    // every existing row with 'pr' (the safe default: nothing is ever pushed to the target by the tool).
    (db) => {
        db.exec(`ALTER TABLE projects ADD COLUMN promotionMode TEXT NOT NULL DEFAULT 'pr'`);
    },
    // Step 7 — M9 dependency edges: a JSON array of the task ids this task waits on (nullable; NULL/absent
    // = []). A child branches off the integration tip when it STARTS, so the scheduler must not start it
    // until every parent has MERGED. "blocked" is DERIVED at read time from these edges + parent statuses —
    // no new TaskStatus, the state machine is untouched. tasks.ts parses defensively (bad JSON → []).
    (db) => {
        db.exec(`ALTER TABLE tasks ADD COLUMN dependsOn TEXT`);
    },
    // Step 8 — M10 plan ingestion: the `plans` grouping entity (the PRD's durable home — the .helm/plan/
    // dir is transient and cleared at approve) + a nullable tasks.planId (NULL = hand-made; a Phase-1 row
    // is untouched). Every task an approve produces is stamped with its plan's id. New table, so a fresh
    // CREATE; the ALTER adds one nullable column (the M9 dependsOn precedent for a tasks-table ALTER).
    (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS plans (
                id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
                prdText TEXT NOT NULL, createdAt INTEGER NOT NULL
            );
        `);
        db.exec(`ALTER TABLE tasks ADD COLUMN planId TEXT`);
    },
    // Step 9 — M12 per-task cost cap: a nullable REAL USD spend ceiling the Ralph loop enforces so a
    // runaway task can't burn unbounded tokens overnight (nullable; NULL = engine default 25). Mapped in
    // resolveLoopConfig with ?? (an explicit 0 is honored and means spawn nothing).
    (db) => {
        db.exec(`ALTER TABLE projects ADD COLUMN costCapUsd REAL`);
    },
    // Step 10 — M13 per-project Docker-jail opt-in: a nullable image tag. NULL = host mode (spawn exactly
    // as before — the `terminalCommand` NULL→in-app precedent, semantics-by-null). Non-null → jailed spawns
    // run `docker run <image> … claude …` through the spawn chokepoint. No per-task override (parked, ledger).
    (db) => {
        db.exec(`ALTER TABLE projects ADD COLUMN jailImage TEXT`);
    },
    // Step 11 — M16 conductor: the per-project persistent conductor session id (nullable; NULL = none
    // recorded). Written at FRESH launch (the forced `--session-id`, known before claude writes a byte);
    // the resume-guard treats it as resumable only once claude's persisted session file exists on disk
    // (engine/conductor.ts) — the M5 "recorded ⇔ resumable" kernel, conductor edition.
    (db) => {
        db.exec(`ALTER TABLE projects ADD COLUMN conductorSessionId TEXT`);
    },
    // Step 12 — M17 failure ledger: the durable, append-only history of terminal needs-human failures
    // (tasks.failureReason is one mutable field — overwritten by the next failure, nulled on recovery;
    // this table is what survives). Captured at the DB status-write chokepoint (tasks.updateTask): one
    // row per needs-human write, all still-open rows stamped resolved/abandoned on the task's terminal
    // outcome. Indexed on the two read paths: per-project listing + per-task resolution stamping.
    (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS failures (
                id TEXT PRIMARY KEY, taskId TEXT NOT NULL, projectId TEXT NOT NULL,
                kind TEXT NOT NULL, reason TEXT NOT NULL, iterationIndex INTEGER,
                createdAt INTEGER NOT NULL, resolvedAt INTEGER, resolution TEXT
            );
            CREATE INDEX IF NOT EXISTS failures_projectId ON failures(projectId);
            CREATE INDEX IF NOT EXISTS failures_taskId ON failures(taskId);
        `);
    },
];

// Apply every step past the DB's current user_version, advancing the cursor as we go.
// Exported for testing the ALTER path against a hand-built old-shape DB.
export function migrate(db: Db): void {
    const current = db.pragma("user_version", { simple: true }) as number;
    for (let v = current; v < STEPS.length; v++) {
        STEPS[v](db);
        db.pragma(`user_version = ${v + 1}`);
    }
}

export function openDb(path: string): Db {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    migrate(db);
    return db;
}
