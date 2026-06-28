// tests/db/projects.test.ts
import { openDb } from "../../src/main/db/db";
import { insertProject, listProjects, getProject } from "../../src/main/db/projects";

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
