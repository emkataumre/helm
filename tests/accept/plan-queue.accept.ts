// Plan-queue acceptance — the DEFINITIVE live proof for "wire multi-draft read + approve-by-subdir end to
// end". `npm run check` (typecheck + vitest) CANNOT run this: it needs the built Electron app + a real
// window (electron ABI + live DOM), so the gate (tests/verify/planqueue/wire.test.ts) is necessary but NOT
// sufficient — THIS is the real verification, a human runs it before promote. It stages TWO <slug>/ subdir
// drafts directly (the drop seam works from any writer), then asserts the REAL watcher → composePlanQueueState
// → plan-channel superset → PlanQueueRail path: the rail exposes BOTH drafts as Approvable, and approving one
// BY NAME (its own Approve button) queues THAT draft's tasks while leaving the other draft intact on disk.
//
// Same regime as plan.accept.ts: drives the built app, asserts via window.helm (the prod-safe agent handle) +
// visible DOM text, NOT data-verify (stripped in prod). TWO HARD CONSTRAINTS honoured: (1) the scheduler is
// PAUSED before approve — approve kicks it, and an unpaused queued task would auto-spawn a real claude;
// (2) the conductor PTY sits idle — the test NEVER writes to it (no real claude conversation). try/finally
// closes the app so a failed assertion never leaks an Electron process.
import { describe, it, expect } from "vitest";
import type { Page } from "playwright-core";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { launchHelm, seededProject, until } from "./harness";

async function pauseFleet(page: Page): Promise<void> {
    await page.evaluate(() => window.helm.setSchedulerPaused(true));
    await until(async () => (await page.evaluate(() => window.helm.getSchedulerState())).paused, { label: "scheduler paused" });
}

const listTasks = (page: Page) => page.evaluate(() => window.helm.listTasks());
const stageNow = async (page: Page): Promise<string> => (await page.locator(".helm-stage .seg.now").textContent()) ?? "";

// ALPHA draft: 2 tasks with one dependency edge — its Approve button reads "Approve — queue 2 tasks", unique
// against beta's "1 task", so the test clicks the RIGHT draft with no ambiguity. acceptance uses the target
// repo's real `check` script (no static warn — the card is clean).
const alphaTasks = JSON.stringify({
    planTitle: "Alpha plan",
    tasks: [
        { slug: "a1", title: "Alpha task one", intent: "build alpha base", acceptance: ["npm run check"], scopeHint: null, dependsOn: [] },
        { slug: "a2", title: "Alpha task two", intent: "extend alpha", acceptance: ["npm run check"], scopeHint: null, dependsOn: ["a1"] },
    ],
}, null, 2);
// BETA draft: 1 task — its Approve reads "Approve — queue 1 task".
const betaTasks = JSON.stringify({
    planTitle: "Beta plan",
    tasks: [{ slug: "b1", title: "Beta task one", intent: "build beta", acceptance: ["npm run check"], scopeHint: null, dependsOn: [] }],
}, null, 2);

async function openConductorPane(page: Page): Promise<void> {
    await page.locator(".helm-sidebar").getByText("PlanQueueProj").click();
    await page.getByRole("tab", { name: "Conductor" }).click();
    await page.getByRole("button", { name: "Fresh session", exact: true }).click();
    await until(async () => (await stageNow(page)).includes("conversing"), { timeoutMs: 30_000, label: "stage = conversing" });
}

describe("plan-queue", () => {
    it("two subdir drafts → rail exposes 2 Approvable drafts; approving one BY NAME queues that draft, the other stays intact", async () => {
        const { repo, seed } = seededProject("PlanQueueProj");
        const planDir = join(repo, ".helm", "plan");
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // Pause BEFORE anything queues — approve kicks the scheduler; a queued+eligible task would auto-spawn.
            await pauseFleet(page);

            // Open the conductor via the real UI (project view → Conductor → [Fresh session]). The tab mount +
            // launch ensure .helm/plan/ + the live watcher; the conductor PTY spawns idle (never written to).
            await openConductorPane(page);

            // Stage TWO <slug>/ subdir drafts — the multi-draft seam. Each is its own prd.md + tasks.json. The
            // subdir creation fires the flat-dir watch; by the time the debounced read runs, both drafts' files
            // are on disk (the writes are synchronous), so the queue rail materializes BOTH.
            for (const [name, tasks] of [["alpha", alphaTasks], ["beta", betaTasks]] as const) {
                mkdirSync(join(planDir, name), { recursive: true });
                writeFileSync(join(planDir, name, "prd.md"), `# ${name} PRD\n`);
                writeFileSync(join(planDir, name, "tasks.json"), tasks);
            }

            // The multi-draft face: the draft-set overline + BOTH plan titles + BOTH per-draft Approve buttons.
            // Match the dash-free tail of the overline ("draft set — N drafts · per-draft Approve is the authority").
            await page.getByText("per-draft Approve is the authority", { exact: false }).waitFor({ state: "visible", timeout: 30_000 });
            await page.getByText("Alpha plan", { exact: false }).first().waitFor({ state: "visible", timeout: 15_000 });
            await page.getByText("Beta plan", { exact: false }).first().waitFor({ state: "visible", timeout: 15_000 });
            const alphaApprove = page.getByRole("button", { name: /queue 2 tasks/ });
            const betaApprove = page.getByRole("button", { name: /queue 1 task/ });
            await alphaApprove.waitFor({ state: "visible", timeout: 15_000 });
            await betaApprove.waitFor({ state: "visible", timeout: 15_000 });

            // window.helm (machine-readable): drafts are file-side only until Approve — nothing queued yet.
            expect((await listTasks(page)).length).toBe(0);

            // Approve ALPHA by its OWN button → the ipc approves .helm/plan/alpha/'s 2 tasks. onApproved routes
            // to the board; the queued rows are born there.
            await alphaApprove.click();
            const tasks = await until(async () => { const ts = await listTasks(page); return ts.length === 2 ? ts : null; }, { label: "alpha's 2 tasks queued" });

            // Exactly ALPHA's two tasks, same plan, the slug edge resolved to the parent's real id — and NONE of
            // beta's tasks leaked in (approve touched only the named subdir).
            expect(tasks.map((t) => t.title).sort()).toEqual(["Alpha task one", "Alpha task two"]);
            expect(tasks.some((t) => t.title.startsWith("Beta"))).toBe(false);
            const parent = tasks.find((t) => t.dependsOn.length === 0)!;
            const child = tasks.find((t) => t.dependsOn.length > 0)!;
            expect(parent.planId).toBeTruthy();
            expect(child.planId).toBe(parent.planId);
            expect(child.dependsOn).toEqual([parent.id]);
            expect(parent.status).toBe("queued");
            expect(child.status).toBe("queued");

            // fs: alpha's subdir is cleared (rows durable), beta's subdir + tasks.json stay INTACT — approving
            // one draft can never wipe a sibling.
            await until(() => (!existsSync(join(planDir, "alpha")) ? true : null), { label: "alpha subdir cleared after approve" });
            expect(existsSync(join(planDir, "beta", "tasks.json"))).toBe(true);

            // Back to the conductor: the rail re-pushed with beta ONLY — still its own Approvable card, alpha gone.
            await page.getByRole("tab", { name: "Conductor" }).click();
            await betaApprove.waitFor({ state: "visible", timeout: 15_000 });
            await page.getByText("Beta plan", { exact: false }).first().waitFor({ state: "visible", timeout: 15_000 });
            expect(await page.getByText("Alpha plan", { exact: false }).count()).toBe(0);
            expect(await page.getByRole("button", { name: /queue 2 tasks/ }).count()).toBe(0);
        } finally {
            await helm.close();
        }
    });
});
