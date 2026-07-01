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
    expect(got.terminalCommand).toBeNull();
    expect(got.autoModeEnvironment).toBeNull();
    db.close();
});

// M6-③: promotionMode is a NOT NULL TEXT column (DEFAULT 'pr') — the graduation strategy for the
// project-level batch Promote (pr | direct | strict). Defaults to 'pr' when absent on insert, round-trips
// a set value, and is patchable like the other config fields.
it("defaults promotionMode to 'pr', round-trips a set value, and updateProject patches it", () => {
    const db = openDb(":memory:");
    const bare = insertProject(db, { name: "Bare", repoPath: "/r", targetBranch: "main", checkCommand: "c" });
    expect(getProject(db, bare.id)?.promotionMode).toBe("pr"); // absent → the 'pr' default

    const direct = insertProject(db, { name: "Direct", repoPath: "/r", targetBranch: "main", checkCommand: "c", promotionMode: "direct" });
    expect(getProject(db, direct.id)?.promotionMode).toBe("direct");

    updateProject(db, direct.id, { promotionMode: "strict" });
    expect(getProject(db, direct.id)?.promotionMode).toBe("strict");
    db.close();
});

// M6-②: the per-project auto-mode trusted-environment is a nullable TEXT column (NULL = engine
// default ["$defaults"]), set on insert and patchable like the other config fields. Stored raw
// (the confirmed shape from the Task-1 spike is a string[] of NL trust lines; the builder composes).
it("round-trips a set autoModeEnvironment, and updateProject patches it", () => {
    const db = openDb(":memory:");
    const env = "**Trusted internal domains**: registry.acme.internal";
    const p = insertProject(db, { name: "Env", repoPath: "/r", targetBranch: "main", checkCommand: "c", autoModeEnvironment: env });
    expect(getProject(db, p.id)?.autoModeEnvironment).toBe(env);
    updateProject(db, p.id, { autoModeEnvironment: "**Trusted cloud buckets**: s3://acme-private" });
    expect(getProject(db, p.id)?.autoModeEnvironment).toBe("**Trusted cloud buckets**: s3://acme-private");
    updateProject(db, p.id, { autoModeEnvironment: null }); // explicit null clears it back to the default
    expect(getProject(db, p.id)?.autoModeEnvironment).toBeNull();
    db.close();
});

// M5: the drop-in terminal launch command is a per-project nullable column (NULL = engine default
// template), set on insert and patchable like the other config fields.
it("round-trips a set terminalCommand, and updateProject patches it", () => {
    const db = openDb(":memory:");
    const tmpl = 'wt.exe -d "{worktree}" claude {resume}';
    const p = insertProject(db, { name: "Term", repoPath: "/r", targetBranch: "main", checkCommand: "c", terminalCommand: tmpl });
    expect(getProject(db, p.id)?.terminalCommand).toBe(tmpl);
    updateProject(db, p.id, { terminalCommand: "pwsh -NoExit -Command \"cd '{worktree}'\"" });
    expect(getProject(db, p.id)?.terminalCommand).toBe("pwsh -NoExit -Command \"cd '{worktree}'\"");
    updateProject(db, p.id, { terminalCommand: null }); // explicit null clears it back to the default
    expect(getProject(db, p.id)?.terminalCommand).toBeNull();
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

// M4 hardening: a stray leading/trailing space in repoPath silently poisons every `git -C <repo>`
// call (git fails with "cannot change to ' C:\\...'"). Registration must trim string inputs so a
// paste artifact can't brick a project.
it("trims surrounding whitespace on string inputs (a stray space must not poison git -C)", () => {
    const db = openDb(":memory:");
    const p = insertProject(db, {
        name: " Helm ", repoPath: " C:/Temp/helm-target ", targetBranch: " main ",
        checkCommand: " npm run check ", setupCommand: "  node -v  ", model: "  opus  ",
    });
    const got = getProject(db, p.id)!;
    expect(got.repoPath).toBe("C:/Temp/helm-target");
    expect(got.name).toBe("Helm");
    expect(got.targetBranch).toBe("main");
    expect(got.checkCommand).toBe("npm run check");
    expect(got.setupCommand).toBe("node -v");
    expect(got.model).toBe("opus");
    db.close();
});
