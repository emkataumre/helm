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

// An M6-③-shape DB: every project config column INCLUDING promotionMode, user_version pinned at the M6-③
// head (7), tasks WITHOUT dependsOn. Built with a raw handle so migrate() exercises the real ALTER path
// when adding the M9 tasks.dependsOn column (the first tasks-table ALTER since M3's scopeHint).
function m6ThreeShapeDb(): any {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE projects (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, repoPath TEXT NOT NULL,
            integrationBranch TEXT NOT NULL, targetBranch TEXT NOT NULL,
            branchPrefix TEXT NOT NULL, checkCommand TEXT NOT NULL, worktreeDir TEXT NOT NULL,
            setupCommand TEXT, iterationCap INTEGER, noProgressK INTEGER, stallTimeoutMin INTEGER, model TEXT,
            concurrencyCap INTEGER, terminalCommand TEXT, autoModeEnvironment TEXT,
            promotionMode TEXT NOT NULL DEFAULT 'pr'
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
    db.pragma("user_version = 7");
    return db;
}

// An M9-shape DB: every project config column + tasks.dependsOn, user_version pinned at the M9 head (8),
// WITHOUT the plans table or tasks.planId. Built with a raw handle so migrate() exercises the real M10 step
// (a fresh CREATE TABLE plans + the tasks.planId ALTER).
function m9ShapeDb(): any {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE projects (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, repoPath TEXT NOT NULL,
            integrationBranch TEXT NOT NULL, targetBranch TEXT NOT NULL,
            branchPrefix TEXT NOT NULL, checkCommand TEXT NOT NULL, worktreeDir TEXT NOT NULL,
            setupCommand TEXT, iterationCap INTEGER, noProgressK INTEGER, stallTimeoutMin INTEGER, model TEXT,
            concurrencyCap INTEGER, terminalCommand TEXT, autoModeEnvironment TEXT,
            promotionMode TEXT NOT NULL DEFAULT 'pr'
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
            intent TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL,
            branchName TEXT, worktreePath TEXT, diffstat TEXT, failureReason TEXT,
            createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, scopeHint TEXT, dependsOn TEXT
        );
        CREATE TABLE iterations (
            id TEXT PRIMARY KEY, taskId TEXT NOT NULL, idx INTEGER NOT NULL,
            sessionId TEXT, startedAt INTEGER NOT NULL, endedAt INTEGER,
            gateVerdict TEXT, commitSha TEXT, outputTail TEXT,
            inputTokens INTEGER, outputTokens INTEGER, cacheReadTokens INTEGER,
            cacheCreationTokens INTEGER, costUsd REAL, durationMs INTEGER
        );
    `);
    db.pragma("user_version = 8");
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

    // An M3 DB now applies TEN remaining steps (M4 concurrencyCap, M5 terminalCommand, M6-② autoModeEnvironment,
    // M6-③ promotionMode, M9 tasks.dependsOn, M10 plans + tasks.planId, M12 costCapUsd, M13 jailImage, M16 conductorSessionId, M17 failures).
    expect(colNames(db, "projects")).toEqual(expect.arrayContaining(["concurrencyCap", "terminalCommand", "autoModeEnvironment", "promotionMode", "costCapUsd", "jailImage", "conductorSessionId"]));
    expect(colNames(db, "tasks")).toEqual(expect.arrayContaining(["dependsOn", "planId"]));
    const row = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get() as any;
    expect(row.name).toBe("Legacy");          // existing data survived the ALTERs
    expect(row.concurrencyCap).toBeNull();    // new nullable columns default to NULL
    expect(row.terminalCommand).toBeNull();
    expect(row.autoModeEnvironment).toBeNull();
    expect(row.costCapUsd).toBeNull();
    expect(row.jailImage).toBeNull();
    expect(row.promotionMode).toBe("pr");     // the NOT NULL DEFAULT backfills existing rows
    expect(db.pragma("user_version", { simple: true })).toBe(before + 10);
    db.close();
});

// An M4-shape DB → migrate applies the remaining NINE steps (M5 terminalCommand + M6-② autoModeEnvironment
// + M6-③ promotionMode + M9 tasks.dependsOn + M10 plans/planId + M12 costCapUsd + M13 jailImage + M16 conductorSessionId + M17 failures), the existing row survives, user_version advances by exactly nine.
it("migrates an M4-shape DB through to head: adds terminalCommand + autoModeEnvironment + promotionMode + dependsOn, advances user_version by nine", () => {
    const db = m4ShapeDb();
    db.prepare(
        `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run("p1", "Legacy", "/repo", "integration/ralph", "main", "ralph", "npm test", ".helm/worktrees");
    const before = db.pragma("user_version", { simple: true }) as number;
    expect(before).toBe(4);

    migrate(db);

    expect(colNames(db, "projects")).toEqual(expect.arrayContaining(["terminalCommand", "autoModeEnvironment", "promotionMode"]));
    expect(colNames(db, "tasks")).toContain("dependsOn");
    const row = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get() as any;
    expect(row.name).toBe("Legacy");             // existing data survived the ALTERs
    expect(row.terminalCommand).toBeNull();      // new nullable columns default to NULL
    expect(row.autoModeEnvironment).toBeNull();
    expect(row.costCapUsd).toBeNull();
    expect(row.jailImage).toBeNull();
    expect(row.promotionMode).toBe("pr");        // the NOT NULL DEFAULT backfills existing rows
    expect(db.pragma("user_version", { simple: true })).toBe(before + 9);
    db.close();
});

// An M5-shape DB → migrate applies the remaining EIGHT steps (M6-② autoModeEnvironment + M6-③ promotionMode
// + M9 tasks.dependsOn + M10 plans/planId + M12 costCapUsd + M13 jailImage + M16 conductorSessionId + M17 failures), the existing row survives, user_version advances by exactly eight.
it("migrates an M5-shape DB through to head: adds autoModeEnvironment + promotionMode + dependsOn, advances user_version by eight", () => {
    const db = m5ShapeDb();
    db.prepare(
        `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run("p1", "Legacy", "/repo", "integration/ralph", "main", "ralph", "npm test", ".helm/worktrees");
    const before = db.pragma("user_version", { simple: true }) as number;
    expect(before).toBe(5);

    migrate(db);

    expect(colNames(db, "projects")).toEqual(expect.arrayContaining(["autoModeEnvironment", "promotionMode"]));
    expect(colNames(db, "tasks")).toContain("dependsOn");
    const row = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get() as any;
    expect(row.name).toBe("Legacy");               // existing data survived the ALTER
    expect(row.autoModeEnvironment).toBeNull();    // new nullable column defaults to NULL
    expect(row.costCapUsd).toBeNull();
    expect(row.jailImage).toBeNull();
    expect(row.promotionMode).toBe("pr");          // the NOT NULL DEFAULT backfills existing rows
    expect(db.pragma("user_version", { simple: true })).toBe(before + 8);
    db.close();
});

// An M6-②-shape DB → migrate applies SEVEN remaining steps (M6-③ promotionMode as NOT NULL DEFAULT 'pr'
// + M9 tasks.dependsOn + M10 plans/planId + M12 costCapUsd + M13 jailImage + M16 conductorSessionId + M17 failures).
// promotionMode is the first non-nullable config column, so the ALTER must backfill the existing row with 'pr'
// (SQLite applies the column default to pre-existing rows).
it("migrates an M6-②-shape DB: adds promotionMode ('pr' backfilled) + dependsOn, advances user_version by seven", () => {
    const db = m6TwoShapeDb();
    db.prepare(
        `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run("p1", "Legacy", "/repo", "integration/ralph", "main", "ralph", "npm test", ".helm/worktrees");
    const before = db.pragma("user_version", { simple: true }) as number;
    expect(before).toBe(6);

    migrate(db);

    expect(colNames(db, "projects")).toContain("promotionMode");
    expect(colNames(db, "tasks")).toContain("dependsOn");
    const row = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get() as any;
    expect(row.name).toBe("Legacy");           // existing data survived the ALTER
    expect(row.promotionMode).toBe("pr");      // NOT NULL DEFAULT backfills the pre-existing row
    expect(db.pragma("user_version", { simple: true })).toBe(before + 7);
    db.close();
});

// An M6-③-shape DB (all project config columns present, user_version 7) → migrate applies SIX remaining
// steps (M9 tasks.dependsOn + M10 plans/planId + M12 costCapUsd + M13 jailImage + M16 conductorSessionId
// + M17 failures). The existing task row survives with dependsOn NULL, and user_version advances by exactly six.
it("migrates an M6-③-shape DB: adds tasks.dependsOn + plans (NULL on the existing row), advances user_version by six", () => {
    const db = m6ThreeShapeDb();
    db.prepare(
        `INSERT INTO tasks (id,projectId,title,intent,acceptance,status,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run("t1", "p1", "Legacy task", "do it", '["npm test"]', "queued", 1, 1);
    const before = db.pragma("user_version", { simple: true }) as number;
    expect(before).toBe(7);

    migrate(db);

    expect(colNames(db, "tasks")).toEqual(expect.arrayContaining(["dependsOn", "planId"]));
    const row = db.prepare("SELECT * FROM tasks WHERE id = 't1'").get() as any;
    expect(row.title).toBe("Legacy task"); // existing task data survived the ALTER
    expect(row.dependsOn).toBeNull();       // new nullable column defaults to NULL (read back as [])
    expect(row.planId).toBeNull();
    expect(db.pragma("user_version", { simple: true })).toBe(before + 6);
    db.close();
});

// An M9-shape DB (user_version 8, tasks with dependsOn, no plans/planId) → migrate applies the remaining FIVE
// steps (M10 plans + tasks.planId, M12 costCapUsd, M13 jailImage, M16 conductorSessionId, M17 failures). The
// existing task row survives with planId NULL, plans starts empty, and user_version advances by exactly five.
it("migrates an M9-shape DB: creates plans + adds tasks.planId (NULL on the existing row) + costCapUsd, advances user_version by five", () => {
    const db = m9ShapeDb();
    db.prepare(
        `INSERT INTO tasks (id,projectId,title,intent,acceptance,status,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run("t1", "p1", "Legacy task", "do it", '["npm test"]', "queued", 1, 1);
    const before = db.pragma("user_version", { simple: true }) as number;
    expect(before).toBe(8);

    migrate(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(tables).toContain("plans");                       // the M10 CREATE landed
    expect(colNames(db, "tasks")).toContain("planId");       // the M10 ALTER landed
    expect(colNames(db, "projects")).toContain("costCapUsd"); // the M12 ALTER landed
    expect(colNames(db, "plans")).toEqual(["id", "projectId", "title", "prdText", "createdAt"]);
    const row = db.prepare("SELECT * FROM tasks WHERE id = 't1'").get() as any;
    expect(row.title).toBe("Legacy task");                   // existing task data survived the ALTER
    expect(row.planId).toBeNull();                           // new nullable column defaults to NULL
    expect(db.prepare("SELECT COUNT(*) AS n FROM plans").get()).toEqual({ n: 0 });
    expect(db.pragma("user_version", { simple: true })).toBe(before + 5);
    db.close();
});

// An M10-shape DB (user_version 9, plans + tasks.planId present, WITHOUT costCapUsd/jailImage) → migrate applies
// the remaining FOUR steps (M12 costCapUsd + M13 jailImage + M16 conductorSessionId + M17 failures). The existing
// project row survives with both NULL, and user_version advances by exactly four.
function m10ShapeDb(): any {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE projects (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, repoPath TEXT NOT NULL,
            integrationBranch TEXT NOT NULL, targetBranch TEXT NOT NULL,
            branchPrefix TEXT NOT NULL, checkCommand TEXT NOT NULL, worktreeDir TEXT NOT NULL,
            setupCommand TEXT, iterationCap INTEGER, noProgressK INTEGER, stallTimeoutMin INTEGER, model TEXT,
            concurrencyCap INTEGER, terminalCommand TEXT, autoModeEnvironment TEXT,
            promotionMode TEXT NOT NULL DEFAULT 'pr'
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
            intent TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL,
            branchName TEXT, worktreePath TEXT, diffstat TEXT, failureReason TEXT,
            createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, scopeHint TEXT, dependsOn TEXT, planId TEXT
        );
        CREATE TABLE iterations (
            id TEXT PRIMARY KEY, taskId TEXT NOT NULL, idx INTEGER NOT NULL,
            sessionId TEXT, startedAt INTEGER NOT NULL, endedAt INTEGER,
            gateVerdict TEXT, commitSha TEXT, outputTail TEXT,
            inputTokens INTEGER, outputTokens INTEGER, cacheReadTokens INTEGER,
            cacheCreationTokens INTEGER, costUsd REAL, durationMs INTEGER
        );
        CREATE TABLE plans (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
            prdText TEXT NOT NULL, createdAt INTEGER NOT NULL
        );
    `);
    db.pragma("user_version = 9");
    return db;
}

it("migrates an M10-shape DB: adds costCapUsd + jailImage (NULL on the existing row), advances user_version by four", () => {
    const db = m10ShapeDb();
    db.prepare(
        `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run("p1", "Legacy", "/repo", "integration/ralph", "main", "ralph", "npm test", ".helm/worktrees");
    const before = db.pragma("user_version", { simple: true }) as number;
    expect(before).toBe(9);

    migrate(db);

    expect(colNames(db, "projects")).toEqual(expect.arrayContaining(["costCapUsd", "jailImage"])); // M12 + M13 ALTERs landed
    const row = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get() as any;
    expect(row.name).toBe("Legacy");    // existing data survived the ALTER
    expect(row.costCapUsd).toBeNull();  // new nullable columns default to NULL
    expect(row.jailImage).toBeNull();
    expect(db.pragma("user_version", { simple: true })).toBe(before + 4);
    db.close();
});

// The M13+M16+M17 tail: an M12-shape DB (user_version 10, costCapUsd present, WITHOUT the M13 jailImage
// column) → migrate adds the nullable jailImage + conductorSessionId columns + the failures table. The existing
// project row survives with jailImage NULL (host mode), and user_version advances by exactly three.
function m12ShapeDb(): any {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE projects (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, repoPath TEXT NOT NULL,
            integrationBranch TEXT NOT NULL, targetBranch TEXT NOT NULL,
            branchPrefix TEXT NOT NULL, checkCommand TEXT NOT NULL, worktreeDir TEXT NOT NULL,
            setupCommand TEXT, iterationCap INTEGER, noProgressK INTEGER, stallTimeoutMin INTEGER, model TEXT,
            concurrencyCap INTEGER, terminalCommand TEXT, autoModeEnvironment TEXT,
            promotionMode TEXT NOT NULL DEFAULT 'pr', costCapUsd REAL
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
            intent TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL,
            branchName TEXT, worktreePath TEXT, diffstat TEXT, failureReason TEXT,
            createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, scopeHint TEXT, dependsOn TEXT, planId TEXT
        );
        CREATE TABLE iterations (
            id TEXT PRIMARY KEY, taskId TEXT NOT NULL, idx INTEGER NOT NULL,
            sessionId TEXT, startedAt INTEGER NOT NULL, endedAt INTEGER,
            gateVerdict TEXT, commitSha TEXT, outputTail TEXT,
            inputTokens INTEGER, outputTokens INTEGER, cacheReadTokens INTEGER,
            cacheCreationTokens INTEGER, costUsd REAL, durationMs INTEGER
        );
        CREATE TABLE plans (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
            prdText TEXT NOT NULL, createdAt INTEGER NOT NULL
        );
    `);
    db.pragma("user_version = 10");
    return db;
}

it("migrates an M12-shape DB: adds jailImage (NULL/host-mode on the existing row), advances user_version by three", () => {
    const db = m12ShapeDb();
    db.prepare(
        `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run("p1", "Legacy", "/repo", "integration/ralph", "main", "ralph", "npm test", ".helm/worktrees");
    const before = db.pragma("user_version", { simple: true }) as number;
    expect(before).toBe(10);

    migrate(db);

    expect(colNames(db, "projects")).toContain("jailImage"); // the M13 ALTER landed
    const row = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get() as any;
    expect(row.name).toBe("Legacy");   // existing data survived the ALTER
    expect(row.jailImage).toBeNull();  // new nullable column defaults to NULL (host mode)
    expect(db.pragma("user_version", { simple: true })).toBe(before + 3);
    db.close();
});

// The M16+M17 tail: an M13-shape DB (user_version 11, jailImage present, WITHOUT the M16
// conductorSessionId column) → migrate adds the nullable TEXT conductorSessionId column + the M17
// failures table. The existing project row survives with it NULL, and user_version advances by two.
function m13ShapeDb(): any {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE projects (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, repoPath TEXT NOT NULL,
            integrationBranch TEXT NOT NULL, targetBranch TEXT NOT NULL,
            branchPrefix TEXT NOT NULL, checkCommand TEXT NOT NULL, worktreeDir TEXT NOT NULL,
            setupCommand TEXT, iterationCap INTEGER, noProgressK INTEGER, stallTimeoutMin INTEGER, model TEXT,
            concurrencyCap INTEGER, terminalCommand TEXT, autoModeEnvironment TEXT,
            promotionMode TEXT NOT NULL DEFAULT 'pr', costCapUsd REAL, jailImage TEXT
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
            intent TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL,
            branchName TEXT, worktreePath TEXT, diffstat TEXT, failureReason TEXT,
            createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, scopeHint TEXT, dependsOn TEXT, planId TEXT
        );
        CREATE TABLE iterations (
            id TEXT PRIMARY KEY, taskId TEXT NOT NULL, idx INTEGER NOT NULL,
            sessionId TEXT, startedAt INTEGER NOT NULL, endedAt INTEGER,
            gateVerdict TEXT, commitSha TEXT, outputTail TEXT,
            inputTokens INTEGER, outputTokens INTEGER, cacheReadTokens INTEGER,
            cacheCreationTokens INTEGER, costUsd REAL, durationMs INTEGER
        );
        CREATE TABLE plans (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
            prdText TEXT NOT NULL, createdAt INTEGER NOT NULL
        );
    `);
    db.pragma("user_version = 11");
    return db;
}

it("migrates an M13-shape DB: adds conductorSessionId (NULL on the existing row) + failures, advances user_version by two", () => {
    const db = m13ShapeDb();
    db.prepare(
        `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run("p1", "Legacy", "/repo", "integration/ralph", "main", "ralph", "npm test", ".helm/worktrees");
    const before = db.pragma("user_version", { simple: true }) as number;
    expect(before).toBe(11);

    migrate(db);

    expect(colNames(db, "projects")).toContain("conductorSessionId"); // the M16 ALTER landed
    const row = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get() as any;
    expect(row.name).toBe("Legacy");            // existing data survived the ALTER
    expect(row.conductorSessionId).toBeNull();  // new nullable column defaults to NULL (nothing recorded)
    expect(db.pragma("user_version", { simple: true })).toBe(before + 2);
    db.close();
});

// The M17 step in isolation: an M16-shape DB (user_version 12, conductorSessionId present, WITHOUT the
// failures table) → migrate creates the failures ledger table + its two read-path indexes. Existing rows
// are untouched, the ledger starts empty, and user_version advances by exactly one.
function m16ShapeDb(): any {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE projects (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, repoPath TEXT NOT NULL,
            integrationBranch TEXT NOT NULL, targetBranch TEXT NOT NULL,
            branchPrefix TEXT NOT NULL, checkCommand TEXT NOT NULL, worktreeDir TEXT NOT NULL,
            setupCommand TEXT, iterationCap INTEGER, noProgressK INTEGER, stallTimeoutMin INTEGER, model TEXT,
            concurrencyCap INTEGER, terminalCommand TEXT, autoModeEnvironment TEXT,
            promotionMode TEXT NOT NULL DEFAULT 'pr', costCapUsd REAL, jailImage TEXT, conductorSessionId TEXT
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
            intent TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL,
            branchName TEXT, worktreePath TEXT, diffstat TEXT, failureReason TEXT,
            createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, scopeHint TEXT, dependsOn TEXT, planId TEXT
        );
        CREATE TABLE iterations (
            id TEXT PRIMARY KEY, taskId TEXT NOT NULL, idx INTEGER NOT NULL,
            sessionId TEXT, startedAt INTEGER NOT NULL, endedAt INTEGER,
            gateVerdict TEXT, commitSha TEXT, outputTail TEXT,
            inputTokens INTEGER, outputTokens INTEGER, cacheReadTokens INTEGER,
            cacheCreationTokens INTEGER, costUsd REAL, durationMs INTEGER
        );
        CREATE TABLE plans (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
            prdText TEXT NOT NULL, createdAt INTEGER NOT NULL
        );
    `);
    db.pragma("user_version = 12");
    return db;
}

it("migrates an M16-shape DB: creates the failures ledger (empty, indexed), advances user_version by one", () => {
    const db = m16ShapeDb();
    db.prepare(
        `INSERT INTO tasks (id,projectId,title,intent,acceptance,status,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?)`,
    ).run("t1", "p1", "Legacy task", "do it", '["npm test"]', "queued", 1, 1);
    const before = db.pragma("user_version", { simple: true }) as number;
    expect(before).toBe(12);

    migrate(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(tables).toContain("failures"); // the M17 CREATE landed
    expect(colNames(db, "failures")).toEqual(["id", "taskId", "projectId", "kind", "reason", "iterationIndex", "createdAt", "resolvedAt", "resolution"]);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='failures'").all().map((r: any) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(["failures_projectId", "failures_taskId"]));
    expect(db.prepare("SELECT COUNT(*) AS n FROM failures").get()).toEqual({ n: 0 }); // ledger starts empty
    const row = db.prepare("SELECT * FROM tasks WHERE id = 't1'").get() as any;
    expect(row.title).toBe("Legacy task"); // existing task data untouched
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
