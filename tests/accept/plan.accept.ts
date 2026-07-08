// M10 acceptance — the plan-ingestion pipeline, made agent-free WITHOUT faking anything: after opening the
// planner, the TEST plays the planning session by writing .helm/plan/prd.md then tasks.json DIRECTLY (the
// file-drop seam works from any writer), and asserts the REAL watcher → side rail → approve → queued tasks
// path end to end. Drives the built app; asserts via window.helm (the prod-safe agent handle) + visible DOM
// text, NOT data-verify (stripped in prod). TWO HARD CONSTRAINTS honoured: (1) the scheduler is PAUSED before
// approve — approve kicks it, and an unpaused queued task would auto-spawn a real claude; (2) the planner PTY
// sits idle — the test NEVER writes to it (no real claude conversation). try/finally-closes the app.
//
// M14 cockpit deltas: the planner is a project-view tab opened via [Open the planner]; the stage tracker
// marks the active step with the `.seg.now` class (lowercase labels); a parse-invalid draft lists its errors
// and offers NO approval path at all; Skip pre-flight confirms via dialog.
import { describe, it, expect } from "vitest";
import type { Page } from "playwright-core";
import { writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { launchHelm, seededProject, until } from "./harness";

async function pauseFleet(page: Page): Promise<void> {
    await page.evaluate(() => window.helm.setSchedulerPaused(true));
    await until(async () => (await page.evaluate(() => window.helm.getSchedulerState())).paused, { label: "scheduler paused" });
}

const listTasks = (page: Page) => page.evaluate(() => window.helm.listTasks());
const stageNow = async (page: Page): Promise<string> => (await page.locator(".helm-stage .seg.now").textContent()) ?? "";

// A valid tasks.json: a parent + a child that dependsOn it, the child carrying one HALLUCINATED npm script
// (verify:contents ~ the repo's real verify:content) so a static ⚠ + did-you-mean renders but doesn't block.
const validTasksJson = JSON.stringify({
    planTitle: "accept-plan",
    tasks: [
        { slug: "t1-parent", title: "Parent slice", intent: "build the base", acceptance: ["npm run check"], scopeHint: null, dependsOn: [] },
        { slug: "t2-child", title: "Child slice", intent: "build on the base", acceptance: ["npm run check", "npm run verify:contents"], scopeHint: null, dependsOn: ["t1-parent"] },
    ],
}, null, 2);

// An INVALID tasks.json: the child has an empty acceptance → parsePlanDraft rejects it (no approval path).
const invalidTasksJson = JSON.stringify({
    planTitle: "accept-plan",
    tasks: [{ slug: "t1", title: "T", intent: "i", acceptance: [] }],
}, null, 2);

describe("plan", () => {
    it("watcher → side rail → approve: the drop seam materializes drafts, then queues them with edges resolved", async () => {
        const { repo, projectId, seed } = seededProject("PlanProj");
        void projectId;
        const planDir = join(repo, ".helm", "plan");
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // Pause BEFORE anything queues — approve kicks the scheduler; a queued+eligible task would auto-spawn.
            await pauseFleet(page);

            // Open the planner via the real UI: project view → Planner tab → [Open the planner]. The planner
            // PTY spawns idle; the test never writes to it. openPlanner creates .helm/plan/ + the watcher.
            await page.locator(".helm-sidebar").getByText("PlanProj").click();
            await page.getByRole("tab", { name: "Planner" }).click();
            await page.getByRole("button", { name: "Open the planner", exact: true }).click();
            await until(async () => (await stageNow(page)).includes("conversing"), { timeoutMs: 30_000, label: "stage = conversing" });
            mkdirSync(planDir, { recursive: true }); // defensive — openPlanner already made it

            // Stage flips to PRD when prd.md lands (the watcher fires; assert the stage tracker's active seg).
            writeFileSync(join(planDir, "prd.md"), "# Accept PRD\n\nA small 2-task feature with one dependency edge.\n");
            await until(async () => (await stageNow(page)).includes("prd drafted"), { timeoutMs: 30_000, label: "stage = prd drafted" });

            // A MALFORMED tasks.json flips the stage to Tasks but offers NO approval path: the errors render
            // verbatim ("fix it in the session") and neither Run pre-flight nor Skip exists.
            writeFileSync(join(planDir, "tasks.json"), invalidTasksJson);
            await until(async () => (await stageNow(page)).includes("tasks drafted"), { timeoutMs: 30_000, label: "stage = tasks drafted" });
            await page.getByText("fix it in the session", { exact: false }).waitFor({ state: "visible", timeout: 15_000 });
            await page.getByText(/acceptance/).first().waitFor({ state: "visible", timeout: 15_000 }); // the verbatim parse error
            expect(await page.getByRole("button", { name: /Run pre-flight/ }).count()).toBe(0);
            expect(await page.getByRole("button", { name: /Skip pre-flight/ }).count()).toBe(0);

            // Fix the file → the draft cards render with the ⚠ + did-you-mean, and the approval panel appears.
            writeFileSync(join(planDir, "tasks.json"), validTasksJson);
            await page.getByText(/did you mean/).waitFor({ state: "visible", timeout: 30_000 });
            await page.getByText("verify:content", { exact: false }).first().waitFor({ state: "visible", timeout: 15_000 });
            await page.getByText("t1-parent").first().waitFor({ state: "visible", timeout: 15_000 }); // the dependsOn edge badge
            const skip = page.getByRole("button", { name: "Skip pre-flight & queue", exact: true });
            await skip.waitFor({ state: "visible", timeout: 15_000 });

            // Skip pre-flight (an explicit, confirmed escape) → the engine re-validates from disk, rows are
            // born; the view routes back to the board.
            await skip.click();
            await page.locator(".helm-dialog").getByRole("button", { name: "Skip & queue", exact: true }).click();
            const tasks = await until(async () => { const ts = await listTasks(page); return ts.length === 2 ? ts : null; }, { label: "2 tasks queued after approve" });

            // window.helm (machine-readable): both queued + planId-stamped (same plan); the edge resolved to the
            // parent's real id; the child derives blocked (its parent is unmerged), waiting on the parent.
            const parent = tasks.find((t) => t.dependsOn.length === 0)!;
            const child = tasks.find((t) => t.dependsOn.length > 0)!;
            expect(parent.status).toBe("queued");
            expect(child.status).toBe("queued");
            expect(parent.planId).toBeTruthy();
            expect(child.planId).toBe(parent.planId);       // one plan for both
            expect(child.dependsOn).toEqual([parent.id]);    // slug edge → real id
            expect(child.blocked).toBe(true);                // parent unmerged → derived blocked
            expect(child.waitingOn.map((w) => w.id)).toEqual([parent.id]);

            // The board re-rendered post-approve: the child card shows its WAITING block naming the parent
            // (the parent is queued/in-flight, not stuck), which proves the queued cards landed on the board.
            const childCard = page.locator(".helm-task-card").filter({ hasText: "Child slice" });
            await childCard.getByText("waiting on", { exact: false }).waitFor({ state: "visible", timeout: 15_000 });
            await childCard.getByText("Parent slice").waitFor({ state: "visible", timeout: 15_000 });

            // fs check: approve cleared the transient drop dir (the PRD is now durable in the plans row).
            await until(() => readdirSync(planDir).length === 0 ? true : null, { label: ".helm/plan/ cleared after approve" });
        } finally {
            await helm.close();
        }
    });
});
