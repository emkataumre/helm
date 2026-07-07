// tests/engine/prompt.test.ts
import { describe, it, expect } from "vitest";
import { buildGoalPrompt, buildInstructions, buildTaskDirective, seedProgress } from "../../src/main/engine/prompt";
import type { Project, Task } from "../../src/shared/types";

const project: Project = { id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main", branchPrefix: "ralph", checkCommand: "npm test", worktreeDir: ".helm/worktrees", setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, model: null, concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr" };
const task: Task = { id: "abc", projectId: "p1", title: "Add widget", intent: "Build the widget.", acceptance: ["npm run e2e", "node check.js"], status: "queued", scopeHint: null, dependsOn: [], planId: null, branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0 };

describe("buildGoalPrompt", () => {
    it("opens with /goal and a transcript-provable condition naming check + acceptance", () => {
        const p = buildGoalPrompt(project, task, undefined);
        expect(p.startsWith("/goal ")).toBe(true);
        expect(p).toContain("npm test");          // checkCommand
        expect(p).toContain("npm run e2e");        // acceptance (inline in the condition)
        expect(p).toContain(".ralph/TASK.md");     // the directive pointer — intent is NOT inline
        expect(p).not.toContain("Build the widget.");
        expect(p).toContain(".ralph/INSTRUCTIONS.md");
        expect(p).toContain(".ralph/progress.md");
    });

    it("injects only the most recent prior-gate failure when retrying", () => {
        const p = buildGoalPrompt(project, task, "Error: 1 failing test\nassert(false)");
        expect(p).toContain("previous iteration's gate failed");
        expect(p).toContain("1 failing test");
    });

    // The M12 dogfood incident (2026-07-07): the CLI caps a /goal condition at 4000 chars and counts
    // everything after "/goal " — a long self-contained intent + the 1500-char retry tail blew it,
    // and every retry became a synthetic zero-work turn. The prompt must NEVER exceed the budget.
    it("stays under the CLI's 4000-char /goal cap even with a huge intent and a full retry tail", () => {
        const huge = { ...task, intent: "x".repeat(6000) };
        const p = buildGoalPrompt(project, huge, "e".repeat(1500));
        expect(p.length).toBeLessThanOrEqual(4000);
        expect(p).toContain(".ralph/TASK.md");                     // the directive still reachable
        expect(p).toContain("previous iteration's gate failed");   // the evidence survived intact
        expect(p).not.toContain("…(truncated)");                   // a normal 1500-char tail needs no clamp
    });

    it("clamps oversized retry evidence to the budget, keeping the tail (most recent output)", () => {
        const p = buildGoalPrompt(project, task, "e".repeat(5000));
        expect(p.length).toBeLessThanOrEqual(4000);
        expect(p).toContain("…(truncated)");
        expect(p.endsWith("e".repeat(50) + "\n```\nFix this before anything else.")).toBe(true); // tail kept, head dropped
    });

    it("adds the no-out-of-scope clause to the /goal condition when scopeHint is set", () => {
        const p = buildGoalPrompt(project, { ...task, scopeHint: "src/widgets/**" }, undefined);
        expect(p).toContain("src/widgets/**");
        expect(p.toLowerCase()).toContain("no files outside");
    });

    it("omits the scope clause when scopeHint is null (M2's behaviour)", () => {
        const p = buildGoalPrompt(project, { ...task, scopeHint: null }, undefined);
        expect(p.toLowerCase()).not.toContain("no files outside");
    });
});

describe("buildTaskDirective", () => {
    it("carries the intent verbatim plus every acceptance command (the budget-free home)", () => {
        const d = buildTaskDirective(task);
        expect(d).toContain("Build the widget.");
        expect(d).toContain("- npm run e2e");
        expect(d).toContain("- node check.js");
        expect(d).toContain(task.title);
    });

    it("never truncates an arbitrarily long intent (that is the whole point of the file)", () => {
        const d = buildTaskDirective({ ...task, intent: "y".repeat(10000) });
        expect(d).toContain("y".repeat(10000));
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

    it("pins the exact four progress.md headings so the cockpit can render them", () => {
        const i = buildInstructions();
        for (const h of ["## Current focus", "## Done", "## Remaining", "## Tried & ruled out"]) {
            expect(i).toContain(h);
        }
    });
});
