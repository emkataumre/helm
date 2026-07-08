// M9 acceptance — the cockpit's dependency-gate visibility (the automatable subset of the plan's Task-5
// list; the live dep-ordered agent run, real claude merging in dependency order, stays HUMAN-ONLY). Drives
// the built app; asserts via window.helm (the prod-safe agent handle) + visible DOM text, NOT data-verify
// (the prod build strips those attributes). AGENT-FREE: every task is created/seeded with the scheduler
// PAUSED first (the intake suite proves pause blocks auto-spawn) and every scenario try/finally-closes its
// app, so no real claude ever runs and no Electron process leaks.
//
// M14 cockpit deltas: the blocked card renders a "waiting on" block with parent links; a STUCK card says
// "stuck — a parent needs a human" and offers Clear dependencies, which now confirms via dialog.
import { describe, it, expect } from "vitest";
import type { Page } from "playwright-core";
import { launchHelm, seededProject, seededNeedsHumanBoard, until } from "./harness";

// Pause the fleet (M4 manual mode) BEFORE creating any queued task — an unpaused queued+eligible task would
// auto-start the real claude loop, which the accept harness must never do. Wait until the engine confirms it.
async function pauseFleet(page: Page): Promise<void> {
    await page.evaluate(() => window.helm.setSchedulerPaused(true));
    await until(async () => (await page.evaluate(() => window.helm.getSchedulerState())).paused, { label: "scheduler paused" });
}

const createTask = (page: Page, projectId: string, title: string): Promise<string> =>
    page.evaluate(([pid, t]) => window.helm.createTask({ projectId: pid, title: t, intent: "noop — accept fixture, never runs", acceptance: ["npm run check"] }).then((task) => task.id), [projectId, title] as const);

const listTaskById = (page: Page, id: string) =>
    page.evaluate((tid) => window.helm.listTasks().then((ts) => ts.find((t) => t.id === tid) ?? null), id);

describe("deps", () => {
    it("a queued child with an unmerged (in-flight) parent renders blocked with its waiting-on line", async () => {
        const { projectId, seed } = seededProject("DepsProj");
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            await pauseFleet(page); // create-while-paused → neither task auto-spawns a claude
            // A parent (queued → unmerged) + a child that depends on it, both created through the REAL IPC.
            const parentId = await createTask(page, projectId, "Parent A");
            const childId = await createTask(page, projectId, "Child of A");
            await page.evaluate(([c, p]) => window.helm.setDependsOn(c, [p]), [childId, parentId] as const);

            // window.helm (machine-readable): the child derives blocked, waiting on the parent, still queued.
            const child = await until(async () => {
                const t = await listTaskById(page, childId);
                return t && t.blocked ? t : null;
            }, { label: "child derived blocked" });
            expect(child.status).toBe("queued");
            expect(child.waitingOn.map((w) => w.id)).toEqual([parentId]);
            expect(child.waitingOn[0].status).toBe("queued"); // parent in flight → WAITING (not stuck)

            // The child's card renders the waiting-on block naming the parent, and offers NO
            // Clear-dependencies (that affordance is only for a stuck card).
            const card = page.locator(".helm-task-card").filter({ hasText: "Child of A" });
            await card.getByText("waiting on", { exact: false }).waitFor({ state: "visible", timeout: 15_000 });
            await card.getByText("Parent A").waitFor({ state: "visible", timeout: 15_000 });
            await card.hover();
            expect(await card.getByRole("button", { name: "Clear dependencies" }).count()).toBe(0);
        } finally {
            await helm.close();
        }
    });

    it("a needs-human parent renders the child STUCK; Clear dependencies flips it back to plain queued", async () => {
        // A real needs-human parent (retained worktree, survives boot-reconcile). It never auto-starts, so
        // the seeded board spawns no claude at boot.
        const board = seededNeedsHumanBoard("DepsProj", "Wedged parent");
        const helm = await launchHelm({ seed: board.seed });
        const { page } = helm;
        try {
            await pauseFleet(page); // also guards the post-Clear moment: a cleared child is queued+eligible
            const childId = await createTask(page, board.projectId, "Child of wedged");
            await page.evaluate(([c, p]) => window.helm.setDependsOn(c, [p]), [childId, board.taskId] as const);

            const stuck = await until(async () => {
                const t = await listTaskById(page, childId);
                return t && t.blocked ? t : null;
            }, { label: "child derived blocked (stuck)" });
            expect(stuck.waitingOn[0].status).toBe("needs-human"); // parent wedged → STUCK

            // The stuck card shows the warning line naming the parent + the Clear-dependencies verb.
            const card = page.locator(".helm-task-card").filter({ hasText: "Child of wedged" });
            await card.getByText("stuck — a parent needs a human").waitFor({ state: "visible", timeout: 15_000 });
            await card.getByText("Wedged parent").waitFor({ state: "visible", timeout: 15_000 });
            await card.hover();
            const clear = card.getByRole("button", { name: "Clear dependencies" });
            await clear.waitFor({ state: "visible", timeout: 15_000 });

            // Clear (confirmed via dialog) → the edge is dropped; the child returns to plain queued.
            await clear.click();
            await page.locator(".helm-dialog").getByRole("button", { name: "Clear dependencies", exact: true }).click();
            const cleared = await until(async () => {
                const t = await listTaskById(page, childId);
                return t && !t.blocked && t.dependsOn.length === 0 ? t : null;
            }, { label: "dependencies cleared" });
            expect(cleared.status).toBe("queued");
            await card.hover();
            expect(await card.getByRole("button", { name: "Clear dependencies" }).count()).toBe(0);
        } finally {
            await helm.close();
        }
    });
});
