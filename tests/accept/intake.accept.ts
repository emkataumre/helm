// M8.5 acceptance scenarios — the cockpit intake path (backfills the M1/M3/M4 manual UI checks that the
// original tracer suite skipped): registering a project through the REAL dialog, editing its config, and the
// M4 pause → create-a-task → it lands queued WITHOUT auto-spawning a claude. Drives the built app; asserts
// via window.helm (the prod-safe agent handle) + visible DOM text. Every scenario try/finally-closes its
// app. CRITICAL agent-free invariant: a queued task auto-starts the real claude loop unless the scheduler
// is paused, so the create scenario PAUSES first and then PROVES (a probe-style guard) nothing spawned.
//
// M14 cockpit deltas: register/new-task are dialogs (sidebar button / header button), project config is a
// tab in the project view, the pause toggle is the titlebar switch, and the manual start verb is "Start now".
import { describe, it, expect } from "vitest";
import { launchHelm, seededProject, makeTargetRepo, tmp, until } from "./harness";

describe("intake", () => {
    it("register a project through the dialog → it appears in listProjects + the sidebar/project view (M1/M3)", async () => {
        const repo = tmp("repo");
        makeTargetRepo(repo);
        const helm = await launchHelm();
        const { page } = helm;
        try {
            // Open the Register-project dialog from the sidebar and fill the mandatory fields.
            await page.getByRole("button", { name: "Register project", exact: true }).click();
            const dlg = page.locator(".helm-dialog");
            await dlg.waitFor({ state: "visible", timeout: 15_000 });
            await dlg.getByPlaceholder("C:\\dev\\my-repo").fill(repo);
            await dlg.getByPlaceholder("my-repo", { exact: true }).fill("IntakeProj"); // exact: "C:\dev\my-repo" is a substring match otherwise
            await dlg.getByPlaceholder("npm run check").first().fill("npm run check");
            await dlg.getByRole("button", { name: "Register", exact: true }).click();

            // window.helm (machine-readable): the project was really inserted with the fields we typed
            // (an empty target branch falls back to main — the dialog's documented default).
            const p = await until(async () => (await page.evaluate(() => window.helm.listProjects())).find((x) => x.name === "IntakeProj") ?? null, { label: "project registered" });
            expect(p.repoPath).toBe(repo);
            expect(p.targetBranch).toBe("main");
            expect(p.checkCommand).toBe("npm run check");

            // The renderer picked it up: registration routes to the project view (its h1 + Promote / New
            // task header verbs), and the sidebar lists the project.
            await page.getByRole("heading", { name: "IntakeProj", level: 1 }).waitFor({ state: "visible", timeout: 15_000 });
            await page.getByRole("button", { name: "Promote", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
            await page.locator(".helm-sidebar").getByText("IntakeProj").waitFor({ state: "visible", timeout: 15_000 });
        } finally {
            await helm.close();
        }
    });

    it("edit project config through the Config tab → concurrencyCap persists and surfaces (M3/M4)", async () => {
        const { seed } = seededProject("CfgProj");
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // Navigate: sidebar project → Config tab; raise concurrencyCap to 5 (the placeholder shows the
            // engine default 3); save.
            await page.locator(".helm-sidebar").getByText("CfgProj").click();
            await page.getByRole("tab", { name: "Config" }).click();
            await page.getByPlaceholder("3", { exact: true }).fill("5");
            await page.getByRole("button", { name: "Save config", exact: true }).click();

            // The column really changed (NULL → 5) — read it back off window.helm.
            const p = await until(async () => {
                const found = (await page.evaluate(() => window.helm.listProjects())).find((x) => x.name === "CfgProj");
                return found && found.concurrencyCap === 5 ? found : null;
            }, { label: "concurrencyCap persisted as 5" });
            expect(p.concurrencyCap).toBe(5);
        } finally {
            await helm.close();
        }
    });

    it("pause → create a task through the dialog → it lands QUEUED and does NOT auto-spawn a claude (M1/M3/M4)", async () => {
        const { seed } = seededProject("AcceptProj");
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // Pause the fleet (M4 manual mode) BEFORE creating — an unpaused queued task auto-starts the
            // real claude loop, which the accept harness must never do. The titlebar switch is the toggle
            // (the DS switch hides its input, so click the label). Wait until the engine confirms paused.
            await page.locator(".helm-titlebar .helm-switch").click();
            await until(async () => (await page.evaluate(() => window.helm.getSchedulerState())).paused, { label: "scheduler paused" });
            await page.getByText("paused — nothing will auto-start").waitFor({ state: "visible", timeout: 15_000 });

            // Create a task via the New-task dialog (the fleet header's primary action; the empty board's
            // empty-state renders a second "New task" — take the header's, the first in DOM order).
            await page.getByRole("button", { name: "New task", exact: true }).first().click();
            const dlg = page.locator(".helm-dialog");
            await dlg.waitFor({ state: "visible", timeout: 15_000 });
            await dlg.getByPlaceholder("Short name for the board").fill("Intake task");
            await dlg.getByPlaceholder("Well-specified prose. The agent sees exactly this.").fill("noop — accept harness fixture, never runs");
            await dlg.getByPlaceholder("npm run test:thing").fill("npm run check");
            await dlg.getByRole("button", { name: "Queue task", exact: true }).click();

            // It really landed as a queued task.
            const task = await until(async () => (await page.evaluate(() => window.helm.listTasks()))[0] ?? null, { label: "task created" });
            expect(task.status).toBe("queued");

            // The renderer drew the card with the manual Start-now verb (an unblocked queued card), and the
            // status bar lists the project's slot line at its default cap.
            const card = page.locator(".helm-task-card").filter({ hasText: "Intake task" });
            await card.waitFor({ state: "visible", timeout: 15_000 });
            await card.hover();
            await card.getByRole("button", { name: "Start now", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
            await page.locator(".helm-statusbar").getByText("AcceptProj 0/3").waitFor({ state: "visible", timeout: 15_000 });

            // PROBE (agent-free guard): paused ⇒ the loop must NOT have spawned. Wait well past any start
            // window, then assert the task is STILL queued and the project has 0 running slots. If pausing
            // failed to gate the spawn, this fails loudly instead of quietly running a real claude.
            await new Promise((r) => setTimeout(r, 2500));
            const after = await page.evaluate(() => window.helm.listTasks());
            expect(after[0].status).toBe("queued");
            const st = await page.evaluate(() => window.helm.getSchedulerState());
            expect(st.perProject.find((pp) => pp.projectId === after[0].projectId)?.running ?? 0).toBe(0);
        } finally {
            await helm.close();
        }
    });
});
