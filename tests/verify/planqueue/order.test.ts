// tests/verify/planqueue/order.test.ts
// Plan order + gate columns, stamped at Approve (plan-queue slice 2). The plans table gains queuePos /
// dependsOnPlan / gateMode via the db.ts user_version stepper; approve stamps them from the draft's publish
// metadata (optional top-level tasks.json fields, read through planQueueMetaFromDraft — the exact seam the
// ipc approve handler calls before insertPlan); reads are defensive (bad value → 'strict').
// PROBE 🔍: a pre-migration plans row must read back gateMode='strict' (and NULL order columns) after migrate.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { openDb, migrate } from "../../../src/main/db/db";
import { insertPlan, getPlan, listPlans, planQueueMetaFromDraft, asGateMode } from "../../../src/main/db/plans";
import { parsePlanDraft } from "../../../src/main/engine/planDraft";

const colNames = (db: any, table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

// A pre-queue-shape DB: the M10/M17 plans table WITHOUT the queue columns, user_version pinned at 13 (the
// db.test.ts hardcoded-pin idiom) so migrate() exercises exactly the plan-queue ALTER path — that step only
// touches plans, so only plans needs to exist.
function preQueueShapeDb(): any {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE plans (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
            prdText TEXT NOT NULL, createdAt INTEGER NOT NULL
        );
    `);
    db.pragma("user_version = 13");
    return db;
}

// A draft that parses clean AND carries the plan-queue publish metadata as top-level fields.
const draftWithMeta = (meta: Record<string, unknown>): string =>
    JSON.stringify({ planTitle: "queued plan", tasks: [{ slug: "t1", title: "T", intent: "i", acceptance: ["npm run check"] }], ...meta });

describe("verify/planqueue: the plans-table migration (queuePos / dependsOnPlan / gateMode)", () => {
    // PROBE 🔍 (the migration round-trip): an old-shape row must gain the columns with the SAFE defaults.
    it("a pre-migration plans row gains the columns and reads back gateMode='strict', NULL order/parent", () => {
        const db = preQueueShapeDb();
        db.prepare(`INSERT INTO plans (id,projectId,title,prdText,createdAt) VALUES (?,?,?,?,?)`)
            .run("plan-old", "p1", "Legacy plan", "# old prd", 42);

        migrate(db);

        expect(colNames(db, "plans")).toEqual(
            expect.arrayContaining(["queuePos", "dependsOnPlan", "gateMode"]),
        );
        const row = getPlan(db, "plan-old")!;
        expect(row.title).toBe("Legacy plan");   // existing data survived the ALTERs
        expect(row.prdText).toBe("# old prd");
        expect(row.queuePos).toBeNull();          // nullable columns default to NULL
        expect(row.dependsOnPlan).toBeNull();
        expect(row.gateMode).toBe("strict");      // NOT NULL DEFAULT backfills the safe mode
        expect(db.pragma("user_version", { simple: true })).toBe(14);
        db.close();
    });

    it("a fresh openDb lands at head with the queue columns present", () => {
        const db = openDb(":memory:");
        expect(colNames(db, "plans")).toEqual(
            expect.arrayContaining(["queuePos", "dependsOnPlan", "gateMode"]),
        );
        db.close();
    });
});

describe("verify/planqueue: approve stamps the queue metadata onto the plan row", () => {
    it("queuePos/dependsOnPlan/gateMode from the draft's publish metadata persist through insertPlan", () => {
        const db = openDb(":memory:");
        const tasksJson = draftWithMeta({ queuePos: 2, dependsOnPlan: "plan-parent", gateMode: "yolo" });
        // The metadata rides tasks.json as unknown-to-the-parser top-level fields — approve's parse gate
        // must still pass, or the stamping path is unreachable.
        expect(parsePlanDraft(tasksJson).ok).toBe(true);

        const plan = insertPlan(db, { projectId: "p1", title: "queued plan", prdText: "# prd", ...planQueueMetaFromDraft(tasksJson) });
        expect(getPlan(db, plan.id)).toMatchObject({ queuePos: 2, dependsOnPlan: "plan-parent", gateMode: "yolo" });
        expect(listPlans(db, "p1")[0]).toMatchObject({ queuePos: 2, dependsOnPlan: "plan-parent", gateMode: "yolo" });
        db.close();
    });

    it("a draft with no publish metadata stamps the safe defaults (NULL order, NULL parent, 'strict')", () => {
        const db = openDb(":memory:");
        const plan = insertPlan(db, { projectId: "p1", title: "plain", prdText: "x", ...planQueueMetaFromDraft(draftWithMeta({})) });
        expect(getPlan(db, plan.id)).toMatchObject({ queuePos: null, dependsOnPlan: null, gateMode: "strict" });
        db.close();
    });

    // PROBE 🔍 (bad publish metadata): every malformed field must fall to its safe default, never throw.
    it("bad metadata reads defensively: unknown gateMode → 'strict', fractional queuePos → NULL, blank parent → NULL", () => {
        const meta = planQueueMetaFromDraft(draftWithMeta({ queuePos: 2.5, dependsOnPlan: "   ", gateMode: "turbo" }));
        expect(meta).toEqual({ queuePos: null, dependsOnPlan: null, gateMode: "strict" });
        expect(planQueueMetaFromDraft("{not json")).toEqual({ queuePos: null, dependsOnPlan: null, gateMode: "strict" });
        expect(asGateMode(undefined)).toBe("strict");
    });

    it("a stored row hand-edited to a garbage gateMode reads back 'strict' (defensive read, not just write)", () => {
        const db = openDb(":memory:");
        const plan = insertPlan(db, { projectId: "p1", title: "edited", prdText: "x", gateMode: "yolo" });
        db.prepare("UPDATE plans SET gateMode = 'chaos' WHERE id = ?").run(plan.id);
        expect(getPlan(db, plan.id)!.gateMode).toBe("strict");
        expect(listPlans(db, "p1")[0].gateMode).toBe("strict");
        db.close();
    });
});
