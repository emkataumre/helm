// M8.5 acceptance scenarios — the cockpit intake path (backfills the M1/M3/M4 manual UI checks that the
// original tracer suite skipped): registering a project through the REAL form, editing its config, and the
// M4 pause → create-a-task → it lands queued WITHOUT auto-spawning a claude. Drives the built app; asserts
// via window.helm (the prod-safe agent handle) + visible DOM text. Every scenario try/finally-closes its
// app. CRITICAL agent-free invariant: a queued task auto-starts the real claude loop unless the scheduler
// is paused, so the create scenario PAUSES first and then PROVES (a probe-style guard) nothing spawned.
import { describe, it, expect } from "vitest";
import { launchHelm, seededProject, makeTargetRepo, tmp, until } from "./harness";

describe("intake", () => {
    it("register a project through the form → it appears in listProjects + the per-project strips (M1/M3)", async () => {
        const repo = tmp("repo");
        makeTargetRepo(repo);
        const helm = await launchHelm();
        const { page } = helm;
        try {
            // Open the Register-project form (a <details>) and fill the three mandatory fields.
            const reg = page.locator("details").filter({ hasText: "Register project" });
            await reg.locator("summary").click();
            await reg.getByPlaceholder("name", { exact: true }).fill("IntakeProj");
            await reg.getByPlaceholder("repoPath", { exact: true }).fill(repo);
            await reg.getByPlaceholder(/checkCommand/).fill("npm run check");
            await reg.getByRole("button", { name: "Register", exact: true }).click();

            // window.helm (machine-readable): the project was really inserted with the fields we typed.
            const p = await until(async () => (await page.evaluate(() => window.helm.listProjects())).find((x) => x.name === "IntakeProj") ?? null, { label: "project registered" });
            expect(p.repoPath).toBe(repo);
            expect(p.targetBranch).toBe("main");
            expect(p.checkCommand).toBe("npm run check");

            // The renderer redrew the per-project strips: a Promote button "<name> (<mode>)" and a
            // free-terminal button "+ <name>". Their presence proves the board picked the new project up.
            await page.getByRole("button", { name: "IntakeProj (pr)", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
            await page.getByRole("button", { name: "+ IntakeProj", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
        } finally {
            await helm.close();
        }
    });

    it("edit project config through the form → concurrencyCap persists and surfaces (M3/M4)", async () => {
        const { seed } = seededProject("CfgProj");
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // Edit-config form: pick the project, raise concurrencyCap to 5, save.
            const cfg = page.locator("details").filter({ hasText: "Edit project config" });
            await cfg.locator("summary").click();
            await cfg.locator("select").first().selectOption({ label: "CfgProj" });
            await cfg.getByPlaceholder("concurrencyCap", { exact: true }).fill("5");
            await cfg.getByRole("button", { name: "Save config", exact: true }).click();

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

    it("pause → create a task through the form → it lands QUEUED and does NOT auto-spawn a claude (M1/M3/M4)", async () => {
        const { seed } = seededProject("AcceptProj");
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // Pause the fleet (M4 manual mode) BEFORE creating — an unpaused queued task auto-starts the
            // real claude loop, which the accept harness must never do. Wait until the engine confirms paused.
            await page.getByRole("button", { name: "Pause (manual mode)", exact: true }).click();
            await until(async () => (await page.evaluate(() => window.helm.getSchedulerState())).paused, { label: "scheduler paused" });
            await page.getByText("paused — start queued tasks by hand").waitFor({ state: "visible", timeout: 15_000 });

            // Create a task via the New-task form.
            const nt = page.locator("details").filter({ hasText: "New task" });
            await nt.locator("summary").click();
            await nt.locator("select").selectOption({ label: "AcceptProj" });
            await nt.getByPlaceholder("title").fill("Intake task");
            await nt.getByPlaceholder(/intent/).fill("noop — accept harness fixture, never runs");
            await nt.getByPlaceholder(/acceptance/).fill("npm run check");
            await nt.getByRole("button", { name: "Create", exact: true }).click();

            // It really landed as a queued task.
            const task = await until(async () => (await page.evaluate(() => window.helm.listTasks()))[0] ?? null, { label: "task created" });
            expect(task.status).toBe("queued");

            // The renderer drew it in the queued lane with the paused-mode manual Run button, and the
            // SchedulerBar now lists the project's slot at its default cap with the queued count.
            await page.getByText("Intake task").waitFor({ state: "visible", timeout: 15_000 });
            await page.getByRole("button", { name: "Run", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
            const slot = await page.getByText(/AcceptProj: 0\/3/).textContent();
            expect(slot ?? "").toContain("1 queued");

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
