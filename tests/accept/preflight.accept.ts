// M11 acceptance — the dynamic pre-flight gate, made agent-free WITHOUT faking anything: after opening the
// planner, the TEST plays the planning session by writing .helm/plan/prd.md then tasks.json directly, clicks
// [Run pre-flight] in the real UI, and asserts the REAL throwaway-worktree run classifies all three flavours.
// Pre-flight REALLY executes the draft's acceptance commands in a throwaway worktree off the integration tip —
// that's the point — so the seeded commands are snappy (npm scripts that are node -e one-liners; NO setupCommand,
// so no slow install). Drives the built app; asserts via window.helm (the prod-safe agent handle) + visible DOM
// text, NOT data-verify (stripped in prod). HARD CONSTRAINTS honoured: (1) the scheduler is PAUSED before
// Confirm — confirm kicks it, and an unpaused queued task would auto-spawn a real claude; (2) the planner PTY
// sits idle — the test NEVER writes to it (no real claude conversation). try/finally-closes the app.
import { describe, it, expect } from "vitest";
import type { Page } from "playwright-core";
import { writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { launchHelm, seededProject, until } from "./harness";

async function pauseFleet(page: Page): Promise<void> {
    await page.evaluate(() => window.helm.setSchedulerPaused(true));
    await until(async () => (await page.evaluate(() => window.helm.getSchedulerState())).paused, { label: "scheduler paused" });
}

const listTasks = (page: Page) => page.evaluate(() => window.helm.listTasks());
function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

// ONE task whose three acceptance lines cover all three dynamic flavours against the seeded target repo:
//  · npm run verify:red    → a LEGIT gate, red-before-work WITH output  → ok-red (the expected TDD-red)
//  · npm run check         → the always-green floor (exit 0)            → warn-already-green
//  · npm run verify:contnt → a HALLUCINATED script (~ verify:content)   → warn-missing + did-you-mean
const draftJson = JSON.stringify({
    planTitle: "preflight-accept",
    tasks: [{
        slug: "t1", title: "Preflight task", intent: "exercise all three pre-flight flavours",
        acceptance: ["npm run verify:red", "npm run check", "npm run verify:contnt"], scopeHint: null, dependsOn: [],
    }],
}, null, 2);

describe("preflight", () => {
    it("Run pre-flight classifies all three flavours; Confirm gates on acks; approve queues; no throwaway leaks", async () => {
        const { repo, projectId, seed } = seededProject("PreflightProj");
        void projectId;
        // THE FRESH-PROJECT REGRESSION (found in M10 manual acceptance): a just-registered project has NO
        // integration branch (the engine only creates it when the first task runs) and pre-flight hung forever.
        // The harness's makeTargetRepo pre-creates it — kinder than reality — so delete it: this scenario now
        // runs pre-flight against the real fresh state, and passing proves the ensure-branch fix end to end.
        git(repo, ["branch", "-D", "integration/ralph"]);
        const planDir = join(repo, ".helm", "plan");
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // Pause BEFORE anything queues — Confirm kicks the scheduler; a queued+eligible task would auto-spawn.
            await pauseFleet(page);

            // Open the planner via the real UI button → PlannerView mounts (idle planner PTY + side rail).
            await page.getByRole("button", { name: "Plan: PreflightProj", exact: true }).click();
            await page.getByText(/Conversing[^A-Za-z]*now/).waitFor({ state: "visible", timeout: 30_000 });
            mkdirSync(planDir, { recursive: true });

            writeFileSync(join(planDir, "prd.md"), "# Preflight PRD\n\nOne task, three acceptance flavours.\n");
            await page.getByText(/PRD drafted[^A-Za-z]*now/).waitFor({ state: "visible", timeout: 30_000 });

            writeFileSync(join(planDir, "tasks.json"), draftJson);
            await page.getByText(/Tasks drafted[^A-Za-z]*now/).waitFor({ state: "visible", timeout: 30_000 });

            // [Run pre-flight] — REALLY builds a throwaway worktree off integration/ralph and runs the 3 commands.
            const runBtn = page.getByRole("button", { name: /Run pre-flight/ });
            await until(async () => (await runBtn.isDisabled()) ? null : true, { label: "run pre-flight enabled once valid" });
            await runBtn.click();

            // The verdict panel lands with all three flavours, the did-you-mean, and the ok-red evidence tail.
            await page.getByText("already green").waitFor({ state: "visible", timeout: 60_000 });      // warn-already-green
            await page.getByText("red (expected)").waitFor({ state: "visible", timeout: 30_000 });     // ok-red
            await page.getByText(/did you mean/).waitFor({ state: "visible", timeout: 30_000 });        // warn-missing …
            await page.getByText("verify:content", { exact: false }).first().waitFor({ state: "visible", timeout: 15_000 }); // … its did-you-mean
            await page.getByText(/preflight red: gate not yet satisfied/).waitFor({ state: "visible", timeout: 15_000 });    // the ok-red tail

            // Confirm is DISABLED until BOTH warns (already-green + missing) are acked.
            const confirm = page.getByRole("button", { name: /Confirm/ });
            await until(async () => (await confirm.isDisabled()) ? true : null, { label: "confirm disabled until acked" });
            const boxes = page.getByRole("checkbox");
            await until(async () => (await boxes.count()) === 2 ? true : null, { label: "exactly two ack checkboxes (the two warns)" });
            await boxes.nth(0).check();
            await until(async () => (await confirm.isDisabled()) ? true : null, { label: "confirm still disabled with one warn unacked" });
            await boxes.nth(1).check();
            await until(async () => (await confirm.isDisabled()) ? null : true, { label: "confirm enabled once BOTH warns acked" });

            // Confirm → the engine RE-RUNS pre-flight server-side, re-asserts the acks, births the row, clears the dir.
            await confirm.click();
            const tasks = await until(async () => { const ts = await listTasks(page); return ts.length === 1 ? ts : null; }, { label: "1 task queued after confirm" });
            expect(tasks[0].status).toBe("queued");   // paused → sits queued, never auto-spawns a real claude
            expect(tasks[0].planId).toBeTruthy();      // born from the plan

            // The transient drop dir cleared (the PRD is now durable in the plans row).
            await until(() => readdirSync(planDir).length === 0 ? true : null, { label: ".helm/plan/ cleared after confirm" });

            // NO helm/preflight-* throwaway worktree OR branch remains — both pre-flight runs cleaned up (fs + git).
            expect(git(repo, ["worktree", "list", "--porcelain"])).not.toMatch(/helm\/preflight-/);
            expect(git(repo, ["branch", "--list", "helm/preflight-*"]).trim()).toBe("");

            // The fresh-project fix's visible footprint: pre-flight CREATED integration/ralph (off main) rather
            // than hanging on its absence — the branch exists now, at exactly the tip the first task will use.
            expect(git(repo, ["branch", "--list", "integration/ralph"]).trim()).not.toBe("");
            expect(git(repo, ["rev-parse", "integration/ralph"]).trim()).toBe(git(repo, ["rev-parse", "main"]).trim());
        } finally {
            await helm.close();
        }
    });
});
