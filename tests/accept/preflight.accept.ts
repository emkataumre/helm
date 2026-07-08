// M11 acceptance — the dynamic pre-flight gate, made agent-free WITHOUT faking anything: after opening the
// planner, the TEST plays the planning session by writing .helm/plan/prd.md then tasks.json directly, clicks
// [Run pre-flight] in the real UI, and asserts the REAL throwaway-worktree run classifies all three flavours.
// Pre-flight REALLY executes the draft's acceptance commands in a throwaway worktree off the integration tip —
// that's the point — so the seeded commands are snappy (npm scripts that are node -e one-liners; NO setupCommand,
// so no slow install). Drives the built app; asserts via window.helm (the prod-safe agent handle) + visible DOM
// text, NOT data-verify (stripped in prod). HARD CONSTRAINTS honoured: (1) the scheduler is PAUSED before
// Confirm — confirm kicks it, and an unpaused queued task would auto-spawn a real claude; (2) the planner PTY
// sits idle — the test NEVER writes to it (no real claude conversation). try/finally-closes the app.
//
// M14 cockpit deltas: verdict labels are "expected red" / "already green" / "could not run"; evidence tails
// sit behind a per-row [Show output tail] toggle; ack checkboxes hide their inputs (click the .helm-check
// label); Run pre-flight only exists once the draft parses.
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
const stageNow = async (page: Page): Promise<string> => (await page.locator(".helm-stage .seg.now").textContent()) ?? "";
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

            // Open the planner via the real UI (project view → Planner tab → Open the planner; idle PTY + rail).
            await page.locator(".helm-sidebar").getByText("PreflightProj").click();
            await page.getByRole("tab", { name: "Planner" }).click();
            await page.getByRole("button", { name: "Open the planner", exact: true }).click();
            await until(async () => (await stageNow(page)).includes("conversing"), { timeoutMs: 30_000, label: "stage = conversing" });
            mkdirSync(planDir, { recursive: true });

            writeFileSync(join(planDir, "prd.md"), "# Preflight PRD\n\nOne task, three acceptance flavours.\n");
            await until(async () => (await stageNow(page)).includes("prd drafted"), { timeoutMs: 30_000, label: "stage = prd drafted" });

            writeFileSync(join(planDir, "tasks.json"), draftJson);
            await until(async () => (await stageNow(page)).includes("tasks drafted"), { timeoutMs: 30_000, label: "stage = tasks drafted" });

            // [Run pre-flight] — REALLY builds a throwaway worktree off integration/ralph and runs the 3 commands.
            // The button only exists once the draft parses, so its visibility IS the valid-draft gate.
            const runBtn = page.getByRole("button", { name: /Run pre-flight/ });
            await runBtn.waitFor({ state: "visible", timeout: 30_000 });
            await runBtn.click();

            // The verdict panel lands with all three flavours + the did-you-mean carried onto the warn-missing.
            await page.getByText("already green").first().waitFor({ state: "visible", timeout: 60_000 }); // warn-already-green
            await page.getByText("expected red").first().waitFor({ state: "visible", timeout: 30_000 });  // ok-red
            await page.getByText(/did you mean/).first().waitFor({ state: "visible", timeout: 30_000 });   // warn-missing …
            await page.getByText("verify:content", { exact: false }).first().waitFor({ state: "visible", timeout: 15_000 }); // … its did-you-mean

            // The ok-red evidence tail sits behind the row's toggle — expand the verify:red row (report rows
            // follow the draft's acceptance order, so it's the first toggle) and read the real output.
            await page.getByRole("button", { name: "Show output tail" }).first().click();
            await page.getByText(/preflight red: gate not yet satisfied/).waitFor({ state: "visible", timeout: 15_000 });

            // Confirm is DISABLED until BOTH warns (already-green + missing) are acked. The DS checkbox hides
            // its input, so count via role but CLICK the .helm-check labels.
            const confirm = page.getByRole("button", { name: /Confirm/ });
            await until(async () => (await confirm.isDisabled()) ? true : null, { label: "confirm disabled until acked" });
            const boxes = page.getByRole("checkbox");
            await until(async () => (await boxes.count()) === 2 ? true : null, { label: "exactly two ack checkboxes (the two warns)" });
            await page.locator(".helm-check").nth(0).click();
            await until(async () => (await confirm.isDisabled()) ? true : null, { label: "confirm still disabled with one warn unacked" });
            await page.locator(".helm-check").nth(1).click();
            await until(async () => (await confirm.isDisabled()) ? null : true, { label: "confirm enabled once BOTH warns acked" });

            // Confirm → the engine RE-RUNS pre-flight server-side, re-asserts the acks, births the row, clears the dir.
            await confirm.click();
            const tasks = await until(async () => { const ts = await listTasks(page); return ts.length === 1 ? ts : null; }, { timeoutMs: 60_000, label: "1 task queued after confirm" });
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
