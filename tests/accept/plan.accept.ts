// M10 acceptance — the plan-ingestion pipeline, made agent-free WITHOUT faking anything: after opening the
// planner, the TEST plays the planning session by writing .helm/plan/prd.md then tasks.json DIRECTLY (the
// file-drop seam works from any writer), and asserts the REAL watcher → side rail → approve → queued tasks
// path end to end. Drives the built app; asserts via window.helm (the prod-safe agent handle) + visible DOM
// text, NOT data-verify (stripped in prod). TWO HARD CONSTRAINTS honoured: (1) the scheduler is PAUSED before
// approve — approve kicks it, and an unpaused queued task would auto-spawn a real claude; (2) the planner PTY
// sits idle — the test NEVER writes to it (no real claude conversation). try/finally-closes the app.
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

// A valid tasks.json: a parent + a child that dependsOn it, the child carrying one HALLUCINATED npm script
// (verify:contents ~ the repo's real verify:content) so a static ⚠ + did-you-mean renders but doesn't block.
const validTasksJson = JSON.stringify({
    planTitle: "accept-plan",
    tasks: [
        { slug: "t1-parent", title: "Parent slice", intent: "build the base", acceptance: ["npm run check"], scopeHint: null, dependsOn: [] },
        { slug: "t2-child", title: "Child slice", intent: "build on the base", acceptance: ["npm run check", "npm run verify:contents"], scopeHint: null, dependsOn: ["t1-parent"] },
    ],
}, null, 2);

// An INVALID tasks.json: the child has an empty acceptance → parsePlanDraft rejects it (approve stays disabled).
const invalidTasksJson = JSON.stringify({
    planTitle: "accept-plan",
    tasks: [{ slug: "t1", title: "T", intent: "i", acceptance: [] }],
}, null, 2);

describe("plan", () => {
    it("watcher → side rail → approve: the drop seam materializes drafts, then queues them with edges resolved", async () => {
        const { repo, projectId, seed } = seededProject("PlanProj");
        const planDir = join(repo, ".helm", "plan");
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // Pause BEFORE anything queues — approve kicks the scheduler; a queued+eligible task would auto-spawn.
            await pauseFleet(page);

            // Open the planner via the real UI button → PlannerView mounts (TerminalPane + side rail). The
            // planner PTY spawns idle; the test never writes to it. openPlanner creates .helm/plan/ + the watcher.
            await page.getByRole("button", { name: "Plan: PlanProj", exact: true }).click();
            await page.getByText(/Conversing[^A-Za-z]*now/).waitFor({ state: "visible", timeout: 30_000 });
            mkdirSync(planDir, { recursive: true }); // defensive — openPlanner already made it

            // Stage flips to PRD when prd.md lands (the watcher fires; assert the DOM, loosely on the marker).
            writeFileSync(join(planDir, "prd.md"), "# Accept PRD\n\nA small 2-task feature with one dependency edge.\n");
            await page.getByText(/PRD drafted[^A-Za-z]*now/).waitFor({ state: "visible", timeout: 30_000 });

            // A MALFORMED tasks.json flips the stage to Tasks but keeps the approve controls DISABLED, listing
            // the parse error. M11: the primary is now [Run pre-flight]; the explicit [Skip pre-flight] escape
            // is what this agent-free drop-seam test uses (running pre-flight would execute the throwaway commands
            // — that's preflight.accept.ts's job). Both are disabled while parse-invalid.
            writeFileSync(join(planDir, "tasks.json"), invalidTasksJson);
            await page.getByText(/Tasks drafted[^A-Za-z]*now/).waitFor({ state: "visible", timeout: 30_000 });
            const skip = page.getByRole("button", { name: "Skip pre-flight", exact: true });
            await until(async () => (await skip.isDisabled()) ? true : null, { label: "skip disabled while parse-invalid" });
            await page.getByText(/acceptance/).waitFor({ state: "visible", timeout: 15_000 }); // the verbatim parse error

            // Fix the file → the draft cards render with the ⚠ + did-you-mean, and the approve controls ENABLE.
            writeFileSync(join(planDir, "tasks.json"), validTasksJson);
            await page.getByText(/did you mean/).waitFor({ state: "visible", timeout: 30_000 });
            await page.getByText("verify:content", { exact: false }).first().waitFor({ state: "visible", timeout: 15_000 });
            await page.getByText("depends on: t1-parent").waitFor({ state: "visible", timeout: 15_000 });
            await until(async () => (await skip.isDisabled()) ? null : true, { label: "skip enabled once valid" });

            // Skip pre-flight → the engine re-validates from disk, rows are born; the view routes back to the board.
            await skip.click();
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

            // The board re-rendered post-approve: the child card shows its WAITING line naming the parent (the
            // parent is queued/in-flight, not stuck), which uniquely proves the queued cards landed on the board.
            await page.getByText(/waiting on:.*Parent slice/).waitFor({ state: "visible", timeout: 15_000 });

            // fs check: approve cleared the transient drop dir (the PRD is now durable in the plans row).
            await until(() => readdirSync(planDir).length === 0 ? true : null, { label: ".helm/plan/ cleared after approve" });
        } finally {
            await helm.close();
        }
    });
});
