// Unit tests for the PURE bits of the M8.5 accept harness (SQL assembly + path plumbing). Lives OUTSIDE
// tests/accept/ so the NORMAL suite (npm run check) runs it, while the heavy Electron *.accept.ts
// scenarios stay excluded. Imports only the pure module — no playwright, no better-sqlite3, no node-pty.
import { describe, it, expect } from "vitest";
import { retainedWorktreePath, seedProjectSql, seedTaskSql } from "./accept/seed";

const fwd = (p: string) => p.replace(/\\/g, "/");

describe("retainedWorktreePath", () => {
    it("mirrors the engine's worktreePathFor: <repo>/.helm/worktrees/<sanitized-branch>", () => {
        const p = retainedWorktreePath("C:\\repo", "ralph/task-abc");
        expect(fwd(p)).toBe("C:/repo/.helm/worktrees/ralph-task-abc");
    });
});

describe("seedProjectSql", () => {
    it("assembles a step-0 projects INSERT with engine defaults and SQL-escaping", () => {
        const s = seedProjectSql({ id: "p1", name: "O'Brien", repoPath: "C:\\r" });
        expect(s.startsWith("INSERT INTO projects (")).toBe(true);
        // Apostrophe escaped by doubling (no SQL injection / no broken statement).
        expect(s).toContain("'O''Brien'");
        // Engine defaults are baked in when not provided.
        expect(s).toContain("'integration/ralph'");
        expect(s).toContain("'main'");
        expect(s).toContain("'.helm/worktrees'");
        expect(s.trimEnd().endsWith(";")).toBe(true);
    });
});

describe("seedTaskSql", () => {
    it("stores acceptance as a JSON array (the M6-④ real-JSON lesson), not a bare string", () => {
        const s = seedTaskSql({
            id: "t1", projectId: "p1", title: "Fix it", status: "needs-human",
            branchName: "ralph/task-t1", worktreePath: "C:\\r\\wt", acceptance: ["npm run check"],
            createdAt: 1_700_000_000_000,
        });
        expect(s.startsWith("INSERT INTO tasks (")).toBe(true);
        expect(s).toContain(`'${JSON.stringify(["npm run check"])}'`); // '["npm run check"]'
        expect(s).toContain("'needs-human'");
        expect(s).toContain("'ralph/task-t1'");
        expect(s.trimEnd().endsWith(";")).toBe(true);
    });

    it("emits NULL (not 'null') for an absent worktreePath/branchName", () => {
        const s = seedTaskSql({ id: "t2", projectId: "p1", title: "merged one", status: "merged" });
        expect(s).toContain(",NULL,NULL,"); // branchName,worktreePath both NULL
        expect(s).not.toContain("'null'");
    });
});
