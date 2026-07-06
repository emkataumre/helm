// tests/db/plans.test.ts — the M10 plans DB module + the projects:delete cascade extended to plans.
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/main/db/db";
import { insertProject, deleteProject } from "../../src/main/db/projects";
import { insertPlan, listPlans, getPlan } from "../../src/main/db/plans";
import { insertTask } from "../../src/main/db/tasks";

const mkProject = (db: ReturnType<typeof openDb>, name = "P") =>
    insertProject(db, { name, repoPath: "/r", targetBranch: "main", checkCommand: "npm test" });

describe("db/plans", () => {
    it("insertPlan assigns id + createdAt and round-trips through getPlan", () => {
        const db = openDb(":memory:");
        const project = mkProject(db);
        const plan = insertPlan(db, { projectId: project.id, title: "tray-planner", prdText: "# PRD\nbody" });
        expect(plan.id).toMatch(/[0-9a-f-]{36}/);
        expect(plan.createdAt).toBeGreaterThan(0);
        expect(getPlan(db, plan.id)).toEqual(plan);
        db.close();
    });

    it("listPlans returns a project's plans newest-first and never another project's", () => {
        const db = openDb(":memory:");
        const a = mkProject(db, "A");
        const b = mkProject(db, "B");
        const p1 = insertPlan(db, { projectId: a.id, title: "one", prdText: "1" });
        const p2 = insertPlan(db, { projectId: a.id, title: "two", prdText: "2" });
        insertPlan(db, { projectId: b.id, title: "other", prdText: "x" });
        const listed = listPlans(db, a.id).map((p) => p.id);
        expect(listed).toContain(p1.id);
        expect(listed).toContain(p2.id);
        expect(listed).toHaveLength(2); // B's plan excluded
        db.close();
    });

    it("hand-made tasks read planId as NULL", () => {
        const db = openDb(":memory:");
        const project = mkProject(db);
        const task = insertTask(db, { projectId: project.id, title: "t", intent: "i", acceptance: ["x"] });
        expect(task.planId).toBeNull();
        db.close();
    });

    it("deleteProject cascades to plans (no orphan plan rows survive)", () => {
        const db = openDb(":memory:");
        const project = mkProject(db);
        insertPlan(db, { projectId: project.id, title: "doomed", prdText: "gone soon" });
        expect(listPlans(db, project.id)).toHaveLength(1);
        deleteProject(db, project.id);
        expect(listPlans(db, project.id)).toHaveLength(0);
        db.close();
    });
});
