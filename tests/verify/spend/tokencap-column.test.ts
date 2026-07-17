// tests/verify/spend/tokencap-column.test.ts
// The per-project tokenCap column verify slice, in two parts:
//   Part 1 — the COLUMN: a fresh DB and an existing (pre-column) DB both gain the nullable
//   projects.tokenCap INTEGER via db.ts's idempotent ensure (NOT a numbered user_version step — the
//   head cursor 14 is pinned by hand-built fixture DBs, some partial), and the ensure is safe against
//   a partial fixture with no projects table at all. The real insert/update/get path round-trips a set
//   value, an explicit 0, and NULL.
//   Part 2 — the RESOLUTION: resolveLoopConfig maps a set tokenCap (500000) through faithfully and a
//   NULL/absent one to the 2M engine default. PROBE 🔍: a project with tokenCap explicitly set is NOT
//   overridden by the default — a lying resolver that always returns the engine default MUST FAIL the
//   reconciliation, proving the harness catches exactly that override bug.
//
// Non-circularity: Part 1 reads the column back through raw PRAGMA table_info / SELECT rather than the
// typed mappers, and Part 2 states its expectations as literal numbers (500000 / 2_000_000), not via
// DEFAULT_LOOP_CONFIG-derived arithmetic on the resolver under test.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { openDb, migrate } from "../../../src/main/db/db";
import { insertProject, updateProject, getProject } from "../../../src/main/db/projects";
import { resolveLoopConfig, DEFAULT_LOOP_CONFIG } from "../../../src/main/engine/loopConfig";

const colNames = (db: any, table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

// An existing head-shaped DB from BEFORE the tokenCap column: every numbered step's projects column
// present, user_version pinned at the head (14 — the db.test.ts hardcoded-pin idiom), so migrate()
// exercises exactly the idempotent-ensure path and nothing else.
function preTokenCapShapeDb(): any {
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
    `);
    db.pragma("user_version = 14");
    return db;
}

describe("verify/spend Part 1: the projects.tokenCap column exists on fresh AND existing DBs", () => {
    it("a fresh openDb lands with the tokenCap column present", () => {
        const db = openDb(":memory:");
        expect(colNames(db, "projects")).toContain("tokenCap");
        db.close();
    });

    it("an existing pre-column DB gains tokenCap; the row survives with NULL; the pinned cursor is untouched", () => {
        const db = preTokenCapShapeDb();
        db.prepare(
            `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir)
             VALUES (?,?,?,?,?,?,?,?)`,
        ).run("p1", "Legacy", "/repo", "integration/ralph", "main", "ralph", "npm test", ".helm/worktrees");
        expect(colNames(db, "projects")).not.toContain("tokenCap"); // genuinely pre-column

        migrate(db);

        expect(colNames(db, "projects")).toContain("tokenCap");
        const row = db.prepare("SELECT * FROM projects WHERE id = 'p1'").get() as any;
        expect(row.name).toBe("Legacy");   // existing data survived the ALTER
        expect(row.tokenCap).toBeNull();   // the new nullable column defaults to NULL (= engine default)
        // The ensure rides OUTSIDE the numbered ledger — the pinned head cursor must not advance.
        expect(db.pragma("user_version", { simple: true })).toBe(14);
        db.close();
    });

    it("the ensure is idempotent — a second migrate is a no-op, no duplicate column", () => {
        const db = openDb(":memory:");
        migrate(db);
        expect(colNames(db, "projects").filter((c) => c === "tokenCap")).toHaveLength(1);
        db.close();
    });

    it("the ensure skips a partial fixture with no projects table at all (the pinned-fixture guarantee)", () => {
        const db = new Database(":memory:");
        db.exec(`
            CREATE TABLE plans (
                id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
                prdText TEXT NOT NULL, createdAt INTEGER NOT NULL
            );
        `);
        db.pragma("user_version = 14");
        expect(() => migrate(db)).not.toThrow();
        expect(db.pragma("user_version", { simple: true })).toBe(14);
        db.close();
    });

    it("round-trips a set tokenCap (incl. an explicit 0), and updateProject patches it", () => {
        const db = openDb(":memory:");
        const p = insertProject(db, { name: "Capped", repoPath: "/r", targetBranch: "main", checkCommand: "c", tokenCap: 500_000 });
        const read = (): any => db.prepare("SELECT tokenCap FROM projects WHERE id = ?").get(p.id);
        expect(read().tokenCap).toBe(500_000);
        updateProject(db, p.id, { tokenCap: 0 });   // explicit 0 is honored (spawn nothing), NOT NULL
        expect(read().tokenCap).toBe(0);
        updateProject(db, p.id, { tokenCap: null }); // explicit null clears it back to the engine default
        expect(read().tokenCap).toBeNull();
        db.close();
    });

    it("an absent tokenCap on insert stores NULL (null, never undefined)", () => {
        const db = openDb(":memory:");
        const p = insertProject(db, { name: "Bare", repoPath: "/r", targetBranch: "main", checkCommand: "c" });
        expect((db.prepare("SELECT tokenCap FROM projects WHERE id = ?").get(p.id) as any).tokenCap).toBeNull();
        db.close();
    });
});

// ── Part 2: resolveLoopConfig maps the column faithfully ─────────────────────────────────────────────

// The minimal structural project resolveLoopConfig reads — everything else NULL (= engine defaults).
const nullConfigProject = (tokenCap?: number | null) => ({
    iterationCap: null, noProgressK: null, stallTimeoutMin: null, costCapUsd: null, tokenCap,
});

// The candidate resolutions. "shipped" is the real resolver; "default-always" is the override bug this
// slice exists to catch — a PROBE that MUST FAIL reconciliation for an explicitly-capped project.
const RESOLVE_CANDIDATES: Record<string, (tokenCap?: number | null) => number | undefined> = {
    "shipped": (tokenCap) => resolveLoopConfig(nullConfigProject(tokenCap)).tokenCap,
    "default-always": () => DEFAULT_LOOP_CONFIG.tokenCap, // the lie: the project's explicit cap is ignored
};

describe("verify/spend Part 2: resolveLoopConfig maps tokenCap (set → honored, NULL/absent → 2M default)", () => {
    it("resolveLoopConfig({tokenCap: 500000}) returns tokenCap 500000", () => {
        expect(RESOLVE_CANDIDATES["shipped"]!(500_000)).toBe(500_000);
    });

    it("a NULL column resolves to the 2M engine default", () => {
        expect(RESOLVE_CANDIDATES["shipped"]!(null)).toBe(2_000_000);
    });

    it("an ABSENT column (a pre-migration row) resolves to the 2M engine default", () => {
        expect(RESOLVE_CANDIDATES["shipped"]!(undefined)).toBe(2_000_000);
    });

    it("an explicit 0 resolves to 0 (spawn nothing), not the default", () => {
        expect(RESOLVE_CANDIDATES["shipped"]!(0)).toBe(0);
    });

    it("PROBE 🔍: a project with tokenCap explicitly set is NOT overridden by the default", () => {
        // The shipped resolver honors the explicit cap…
        expect(RESOLVE_CANDIDATES["shipped"]!(500_000)).toBe(500_000);
        expect(RESOLVE_CANDIDATES["shipped"]!(500_000)).not.toBe(2_000_000);
        // …and the lying default-always resolver MUST FAIL that reconciliation (the harness catches it).
        expect(RESOLVE_CANDIDATES["default-always"]!(500_000)).not.toBe(500_000);
    });

    it("end-to-end: a DB-stored 500000 cap flows through getProject into resolveLoopConfig", () => {
        const db = openDb(":memory:");
        const p = insertProject(db, { name: "E2E", repoPath: "/r", targetBranch: "main", checkCommand: "c", tokenCap: 500_000 });
        const row = getProject(db, p.id)!;
        expect(resolveLoopConfig(row).tokenCap).toBe(500_000);
        // and a bare project's stored NULL resolves to the engine default through the same path
        const bare = insertProject(db, { name: "Bare", repoPath: "/r2", targetBranch: "main", checkCommand: "c" });
        expect(resolveLoopConfig(getProject(db, bare.id)!).tokenCap).toBe(2_000_000);
        db.close();
    });
});
