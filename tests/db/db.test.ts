// tests/db/db.test.ts
import Database from "better-sqlite3";
import { openDb, migrate } from "../../src/main/db/db";

const colNames = (db: any, table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

// An M1/M2-shaped DB: the base tables only, user_version still 0 (the old openDb never set it).
function oldShapeDb(): any {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE projects (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, repoPath TEXT NOT NULL,
            integrationBranch TEXT NOT NULL, targetBranch TEXT NOT NULL,
            branchPrefix TEXT NOT NULL, checkCommand TEXT NOT NULL, worktreeDir TEXT NOT NULL
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
            intent TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL,
            branchName TEXT, worktreePath TEXT, diffstat TEXT, failureReason TEXT,
            createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
        );
        CREATE TABLE iterations (
            id TEXT PRIMARY KEY, taskId TEXT NOT NULL, idx INTEGER NOT NULL,
            sessionId TEXT, startedAt INTEGER NOT NULL, endedAt INTEGER,
            gateVerdict TEXT, commitSha TEXT, outputTail TEXT
        );
    `);
    return db;
}

// An M3-shaped DB: base tables + the M3 config/token columns, user_version pinned at the M3 head (3).
// Built with a raw handle so migrate() exercises the real ALTER path when adding the M4 column.
function m3ShapeDb(): any {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE projects (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, repoPath TEXT NOT NULL,
            integrationBranch TEXT NOT NULL, targetBranch TEXT NOT NULL,
            branchPrefix TEXT NOT NULL, checkCommand TEXT NOT NULL, worktreeDir TEXT NOT NULL,
            setupCommand TEXT, iterationCap INTEGER, noProgressK INTEGER, stallTimeoutMin INTEGER, model TEXT
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
            intent TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL,
            branchName TEXT, worktreePath TEXT, diffstat TEXT, failureReason TEXT,
            createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, scopeHint TEXT
        );
        CREATE TABLE iterations (
            id TEXT PRIMARY KEY, taskId TEXT NOT NULL, idx INTEGER NOT NULL,
            sessionId TEXT, startedAt INTEGER NOT NULL, endedAt INTEGER,
            gateVerdict TEXT, commitSha TEXT, outputTail TEXT,
            inputTokens INTEGER, outputTokens INTEGER, cacheReadTokens INTEGER,
            cacheCreationTokens INTEGER, costUsd REAL, durationMs INTEGER
        );
    `);
    db.pragma("user_version = 3");
    return db;
}

// An M4-shaped DB: the M3 columns + concurrencyCap, user_version pinned at the M4 head (4). Built with
// a raw handle so migrate() exercises the real ALTER path when adding the M5 terminalCommand column.
function m4ShapeDb(): any {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE projects (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, repoPath TEXT NOT NULL,
            integrationBranch TEXT NOT NULL, targetBranch TEXT NOT NULL,
            branchPrefix TEXT NOT NULL, checkCommand TEXT NOT NULL, worktreeDir TEXT NOT NULL,
            setupCommand TEXT, iterationCap INTEGER, noProgressK INTEGER, stallTimeoutMin INTEGER, model TEXT,
            concurrencyCap INTEGER
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
            intent TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL,
            branchName TEXT, worktreePath TEXT, diffstat TEXT, failureReason TEXT,
            createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, scopeHint TEXT
        );
        CREATE TABLE iterations (
            id TEXT PRIMARY KEY, taskId TEXT NOT NULL, idx INTEGER NOT NULL,
            sessionId TEXT, startedAt INTEGER NOT NULL, endedAt INTEGER,
            gateVerdict TEXT, commitSha TEXT, outputTail TEXT,
            inputTokens INTEGER, outputTokens INTEGER, cacheReadTokens INTEGER,
            cacheCreationTokens INTEGER, costUsd REAL, durationMs INTEGER
        );
    `);
    db.pragma("user_version = 4");
    return db;
}

// An M5-shaped DB: the M4 columns + terminalCommand, user_version pinned at the M5 head (5). Built with
// a raw handle so migrate() exercises the real ALTER path when adding the M6 autoModeEnvironment column.
function m5ShapeDb(): any {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE projects (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, repoPath TEXT NOT NULL,
            integrationBranch TEXT NOT NULL, targetBranch TEXT NOT NULL,
            branchPrefix TEXT NOT NULL, checkCommand TEXT NOT NULL, worktreeDir TEXT NOT NULL,
            setupCommand TEXT, iterationCap INTEGER, noProgressK INTEGER, stallTimeoutMin INTEGER, model TEXT,
            concurrencyCap INTEGER, terminalCommand TEXT
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
            intent TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL,
            branchName TEXT, worktreePath TEXT, diffstat TEXT, failureReason TEXT,
            createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, scopeHint TEXT
        );
        CREATE TABLE iterations (
            id TEXT PRIMARY KEY, taskId TEXT NOT NULL, idx INTEGER NOT NULL,
            sessionId TEXT, startedAt INTEGER NOT NULL, endedAt INTEGER,
            gateVerdict TEXT, commitSha TEXT, outputTail TEXT,
            inputTokens INTEGER, outputTokens INTEGER, cacheReadTokens INTEGER,
            cacheCreationTokens INTEGER, costUsd REAL, durationMs INTEGER
        );
    `);
    db.pragma("user_version = 5");
    return db;
}

// An M6-②-shape DB: the M5 columns + autoModeEnvironment, user_version pinned at the M6-② head (6).
// Built with a raw handle so migrate() exercises the real ALTER path when adding the M6-③ promotionMode
// column (NOT NULL DEFAULT 'pr' — the first non-nullable config column, so existing rows must backfill).
function m6TwoShapeDb(): any {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE projects (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, repoPath TEXT NOT NULL,
            integrationBranch TEXT NOT NULL, targetBranch TEXT NOT NULL,
            branchPrefix TEXT NOT NULL, checkCommand TEXT NOT NULL, worktreeDir TEXT NOT NULL,
            setupCommand TEXT, iterationCap INTEGER, noProgressK INTEGER, stallTimeoutMin INTEGER, model TEXT,
            concurrencyCap INTEGER, terminalCommand TEXT, autoModeEnvironment TEXT
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
            intent TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL,
            branchName TEXT, worktreePath TEXT, diffstat TEXT, failureReason TEXT,
            createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, scopeHint TEXT
        );
        CREATE TABLE iterations (
            id TEXT PRIMARY KEY, taskId TEXT NOT NULL, idx INTEGER NOT NULL,
            sessionId TEXT, startedAt INTEGER NOT NULL, endedAt INTEGER,
            gateVerdict TEXT, commitSha TEXT, outputTail TEXT,
            inputTokens INTEGER, outputTokens INTEGER, cacheReadTokens INTEGER,
            cacheCreationTokens INTEGER, costUsd REAL, durationMs INTEGER
        );
    `);
    db.pragma("user_version = 6");
    return db;
}

it("creates projects, tasks, iterations tables", () => {
    const db = openDb(":memory:");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["projects", "tasks", "iterations"]));
    db.close();
});

it("migrates an old-shape DB: adds the M3 columns, preserves the existing row, advances user_version", () => {
    const db = oldShapeDb();
    db.prepare(
        `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run("p1", "Legacy", "/repo", "integration/ralph", "main", "ralph", "npm test", ".helm/worktrees");
    expect(db.pragma("user_version", { simple: true })).toBe(0);

    migrate(db);

    expect(colNames(db, "projects")).toEqual(
        expect.arrayContaining(["setupCommand", "iterationCap", "noProgressK", "stallTimeoutMin", "model"]),
    );
    expect(colNames(db, "tasks")).toContain("scopeHint");
    expect(colNames(db, "iterations")).toEqual(
        expect.arrayContaining(["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "costUsd", "durationMs"]),
    );

    const row = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get() as any;
    expect(row.name).toBe("Legacy");            // existing data survived
    expect(row.setupCommand).toBeNull();        // new columns default to NULL
    expect(row.iterationCap).toBeNull();
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThan(0);
    db.close();
});

it("migrates an M3-shape DB through to head: adds concurrencyCap + terminalCommand (both NULL on the existing row)", () => {
    const db = m3ShapeDb();
    db.prepare(
        `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run("p1", "Legacy", "/repo", "integration/ralph", "main", "ralph", "npm test", ".helm/worktrees");
    const before = db.pragma("user_version", { simple: true }) as number;
    expect(before).toBe(3);

    migrate(db);

    // An M3 DB now applies FOUR remaining steps (M4 concurrencyCap, M5 terminalCommand, M6-② autoModeEnvironment,
    // M6-③ promotionMode).
    expect(colNames(db, "projects")).toEqual(expect.arrayContaining(["concurrencyCap", "terminalCommand", "autoModeEnvironment", "promotionMode"]));
    const row = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get() as any;
    expect(row.name).toBe("Legacy");          // existing data survived the ALTERs
    expect(row.concurrencyCap).toBeNull();    // new nullable columns default to NULL
    expect(row.terminalCommand).toBeNull();
    expect(row.autoModeEnvironment).toBeNull();
    expect(row.promotionMode).toBe("pr");     // the NOT NULL DEFAULT backfills existing rows
    expect(db.pragma("user_version", { simple: true })).toBe(before + 4);
    db.close();
});

// An M4-shape DB → migrate applies the remaining THREE steps (M5 terminalCommand + M6-② autoModeEnvironment
// + M6-③ promotionMode), the existing row survives, user_version advances by exactly three.
it("migrates an M4-shape DB through to head: adds terminalCommand + autoModeEnvironment + promotionMode, advances user_version by three", () => {
    const db = m4ShapeDb();
    db.prepare(
        `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run("p1", "Legacy", "/repo", "integration/ralph", "main", "ralph", "npm test", ".helm/worktrees");
    const before = db.pragma("user_version", { simple: true }) as number;
    expect(before).toBe(4);

    migrate(db);

    expect(colNames(db, "projects")).toEqual(expect.arrayContaining(["terminalCommand", "autoModeEnvironment", "promotionMode"]));
    const row = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get() as any;
    expect(row.name).toBe("Legacy");             // existing data survived the ALTERs
    expect(row.terminalCommand).toBeNull();      // new nullable columns default to NULL
    expect(row.autoModeEnvironment).toBeNull();
    expect(row.promotionMode).toBe("pr");        // the NOT NULL DEFAULT backfills existing rows
    expect(db.pragma("user_version", { simple: true })).toBe(before + 3);
    db.close();
});

// An M5-shape DB → migrate applies the remaining TWO steps (M6-② autoModeEnvironment + M6-③ promotionMode),
// the existing row survives, user_version advances by exactly two.
it("migrates an M5-shape DB through to head: adds autoModeEnvironment + promotionMode, advances user_version by two", () => {
    const db = m5ShapeDb();
    db.prepare(
        `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run("p1", "Legacy", "/repo", "integration/ralph", "main", "ralph", "npm test", ".helm/worktrees");
    const before = db.pragma("user_version", { simple: true }) as number;
    expect(before).toBe(5);

    migrate(db);

    expect(colNames(db, "projects")).toEqual(expect.arrayContaining(["autoModeEnvironment", "promotionMode"]));
    const row = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get() as any;
    expect(row.name).toBe("Legacy");               // existing data survived the ALTER
    expect(row.autoModeEnvironment).toBeNull();    // new nullable column defaults to NULL
    expect(row.promotionMode).toBe("pr");          // the NOT NULL DEFAULT backfills existing rows
    expect(db.pragma("user_version", { simple: true })).toBe(before + 2);
    db.close();
});

// The M6-③ step in isolation: an M6-②-shape DB → migrate adds promotionMode as NOT NULL DEFAULT 'pr'.
// This is the first non-nullable config column, so the ALTER must backfill the existing row with 'pr'
// (SQLite applies the column default to pre-existing rows), and user_version advances by exactly one.
it("migrates an M6-②-shape DB: adds promotionMode ('pr' backfilled on the existing row), advances user_version by one", () => {
    const db = m6TwoShapeDb();
    db.prepare(
        `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run("p1", "Legacy", "/repo", "integration/ralph", "main", "ralph", "npm test", ".helm/worktrees");
    const before = db.pragma("user_version", { simple: true }) as number;
    expect(before).toBe(6);

    migrate(db);

    expect(colNames(db, "projects")).toContain("promotionMode");
    const row = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get() as any;
    expect(row.name).toBe("Legacy");           // existing data survived the ALTER
    expect(row.promotionMode).toBe("pr");      // NOT NULL DEFAULT backfills the pre-existing row
    expect(db.pragma("user_version", { simple: true })).toBe(before + 1);
    db.close();
});

it("migrate is idempotent — a second run is a no-op", () => {
    const db = openDb(":memory:"); // openDb already migrated to the head version
    const head = db.pragma("user_version", { simple: true });
    expect(head).toBeGreaterThan(0);
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(head);
    // and the schema is intact
    expect(colNames(db, "projects")).toContain("model");
    db.close();
});
