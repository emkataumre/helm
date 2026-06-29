// tests/engine/prompt.test.ts
import { describe, it, expect } from "vitest";
import { buildGoalPrompt, buildInstructions, seedProgress } from "../../src/main/engine/prompt";
import type { Project, Task } from "../../src/shared/types";

const project: Project = { id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main", branchPrefix: "ralph", checkCommand: "npm test", worktreeDir: ".helm/worktrees", setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, model: null };
const task: Task = { id: "abc", projectId: "p1", title: "Add widget", intent: "Build the widget.", acceptance: ["npm run e2e", "node check.js"], status: "queued", scopeHint: null, branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0 };

describe("buildGoalPrompt", () => {
    it("opens with /goal and a transcript-provable condition naming check + acceptance", () => {
        const p = buildGoalPrompt(project, task, undefined);
        expect(p.startsWith("/goal ")).toBe(true);
        expect(p).toContain("npm test");          // checkCommand
        expect(p).toContain("npm run e2e");        // acceptance
        expect(p).toContain("Build the widget.");  // intent
        expect(p).toContain(".ralph/INSTRUCTIONS.md");
        expect(p).toContain(".ralph/progress.md");
    });

    it("injects only the most recent prior-gate failure when retrying", () => {
        const p = buildGoalPrompt(project, task, "Error: 1 failing test\nassert(false)");
        expect(p).toContain("previous iteration's gate failed");
        expect(p).toContain("1 failing test");
    });
});

describe("seedProgress", () => {
    it("seeds the four-section structure", () => {
        const s = seedProgress(task);
        for (const h of ["## Current focus", "## Done", "## Remaining", "## Tried & ruled out"]) {
            expect(s).toContain(h);
        }
    });
});

describe("buildInstructions", () => {
    it("tells the agent to read progress first and self-verify check + acceptance", () => {
        const i = buildInstructions();
        expect(i.toLowerCase()).toContain("read");
        expect(i).toContain(".ralph/progress.md");
        expect(i.toLowerCase()).toContain("acceptance");
    });
});
