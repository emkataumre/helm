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

it("migrates an M3-shape DB: adds concurrencyCap (NULL on the existing row), advances user_version by one", () => {
    const db = m3ShapeDb();
    db.prepare(
        `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run("p1", "Legacy", "/repo", "integration/ralph", "main", "ralph", "npm test", ".helm/worktrees");
    const before = db.pragma("user_version", { simple: true }) as number;
    expect(before).toBe(3);

    migrate(db);

    expect(colNames(db, "projects")).toContain("concurrencyCap");
    const row = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get() as any;
    expect(row.name).toBe("Legacy");          // existing data survived the ALTER
    expect(row.concurrencyCap).toBeNull();    // new column defaults to NULL
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
