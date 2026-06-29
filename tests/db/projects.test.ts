// tests/db/projects.test.ts
import { openDb } from "../../src/main/db/db";
import { insertProject, listProjects, getProject, updateProject } from "../../src/main/db/projects";

it("inserts a project with defaults and lists it back", () => {
    const db = openDb(":memory:");
    const p = insertProject(db, { name: "Helm", repoPath: "C:/r", targetBranch: "main", checkCommand: "npm run check" });
    expect(p.id).toBeTruthy();
    expect(p.integrationBranch).toBe("integration/ralph");
    expect(p.branchPrefix).toBe("ralph");
    expect(p.worktreeDir).toBe(".helm/worktrees");
    expect(listProjects(db)).toHaveLength(1);
    expect(getProject(db, p.id)?.name).toBe("Helm");
    db.close();
});

it("round-trips a fully-configured project", () => {
    const db = openDb(":memory:");
    const p = insertProject(db, {
        name: "Full", repoPath: "/r", targetBranch: "main", checkCommand: "npm run check",
        setupCommand: "npm ci", iterationCap: 5, noProgressK: 3, stallTimeoutMin: 20, model: "opus",
    });
    expect(getProject(db, p.id)).toMatchObject({
        setupCommand: "npm ci", iterationCap: 5, noProgressK: 3, stallTimeoutMin: 20, model: "opus",
    });
    db.close();
});

// The null-never-undefined probe: an all-NULL-config project must round-trip cleanly
// (better-sqlite3 throws on `undefined` bindings, and NULL means "use the engine default").
it("round-trips an all-NULL-config project (null, never undefined)", () => {
    const db = openDb(":memory:");
    const p = insertProject(db, { name: "Bare", repoPath: "/r", targetBranch: "main", checkCommand: "c" });
    const got = getProject(db, p.id)!;
    expect(got.setupCommand).toBeNull();
    expect(got.iterationCap).toBeNull();
    expect(got.noProgressK).toBeNull();
    expect(got.stallTimeoutMin).toBeNull();
    expect(got.model).toBeNull();
    expect(got.concurrencyCap).toBeNull();
    db.close();
});

// M4: the scheduler cap is a per-project nullable column, set on insert and patchable like the
// other config fields (NULL = engine default 3).
it("round-trips a set concurrencyCap, and updateProject patches it", () => {
    const db = openDb(":memory:");
    const p = insertProject(db, { name: "Capped", repoPath: "/r", targetBranch: "main", checkCommand: "c", concurrencyCap: 4 });
    expect(getProject(db, p.id)?.concurrencyCap).toBe(4);
    updateProject(db, p.id, { concurrencyCap: 5 });
    expect(getProject(db, p.id)?.concurrencyCap).toBe(5);
    updateProject(db, p.id, { concurrencyCap: null }); // explicit null clears it back to the default
    expect(getProject(db, p.id)?.concurrencyCap).toBeNull();
    db.close();
});

it("updateProject patches config fields, coalescing absent values", () => {
    const db = openDb(":memory:");
    const p = insertProject(db, { name: "Bare", repoPath: "/r", targetBranch: "main", checkCommand: "c" });
    updateProject(db, p.id, { iterationCap: 9, setupCommand: "make setup", stallTimeoutMin: 15 });
    const got = getProject(db, p.id)!;
    expect(got.iterationCap).toBe(9);
    expect(got.setupCommand).toBe("make setup");
    expect(got.stallTimeoutMin).toBe(15);
    expect(got.model).toBeNull(); // untouched
    // explicit null clears a field
    updateProject(db, p.id, { setupCommand: null });
    expect(getProject(db, p.id)?.setupCommand).toBeNull();
    db.close();
});
