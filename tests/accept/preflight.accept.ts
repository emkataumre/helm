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
// M16 delta: the planner pane became the CONDUCTOR — the tab is "Conductor" and the pane is launched via
// the explicit [Fresh session] click (Resume is disabled: a throwaway userData has no recorded session).
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

            // Open the conductor via the real UI (project view → Conductor tab → Fresh session; idle PTY + rail).
            await page.locator(".helm-sidebar").getByText("PreflightProj").click();
            await page.getByRole("tab", { name: "Conductor" }).click();
            await page.getByRole("button", { name: "Fresh session", exact: true }).click();
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

            // Confirm → approve validates the acks against the SERVER-STORED run (overhaul 2026-07-14: no
            // re-execution — the draft hash must still match disk), consumes it, births the row, clears the dir.
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

    // ── Overhaul (2026-07-14) — role-aware vocabulary in the LIVE app ────────────────────────────────
    // A fully role-tagged draft: the regression suite is green (ok-pass, "suite green"), the proof gate is
    // red (ok-red) and the to-be-created proof is missing (ok-planned) → ZERO warns, ZERO ack checkboxes,
    // Confirm enabled IMMEDIATELY. The exact equilibrium noise-collapse cure, asserted end-to-end.
    it("role-tagged draft: expected states need no acks — Confirm enabled with zero checkboxes", async () => {
        const { repo, projectId, seed } = seededProject("RolesProj");
        void projectId;
        const planDir = join(repo, ".helm", "plan");
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            await pauseFleet(page);
            await page.locator(".helm-sidebar").getByText("RolesProj").click();
            await page.getByRole("tab", { name: "Conductor" }).click();
            await page.getByRole("button", { name: "Fresh session", exact: true }).click();
            await until(async () => (await stageNow(page)).includes("conversing"), { timeoutMs: 30_000, label: "stage = conversing" });
            mkdirSync(planDir, { recursive: true });
            writeFileSync(join(planDir, "tasks.json"), JSON.stringify({
                planTitle: "roles-accept",
                tasks: [{
                    slug: "t1", title: "Roles task", intent: "exercise the role-aware verdicts; ships npm run verify:contnt",
                    acceptance: [
                        { cmd: "npm run verify:red", role: "proof" },      // exists, red → ok-red
                        { cmd: "npm run verify:contnt", role: "proof" },   // missing → ok-planned (no did-you-mean tax)
                        { cmd: "npm run check", role: "regression" },      // green → ok-pass
                    ],
                    scopeHint: null, dependsOn: [],
                }],
            }, null, 2));
            await until(async () => (await stageNow(page)).includes("tasks drafted"), { timeoutMs: 30_000, label: "stage = tasks drafted" });

            await page.getByRole("button", { name: /Run pre-flight/ }).click();
            await page.getByText("suite green").first().waitFor({ state: "visible", timeout: 60_000 });   // ok-pass
            await page.getByText("expected red").first().waitFor({ state: "visible", timeout: 30_000 });  // ok-red
            await page.getByText("planned proof").first().waitFor({ state: "visible", timeout: 30_000 }); // ok-planned

            // ZERO ack checkboxes (nothing warns) and Confirm is enabled straight away.
            expect(await page.getByRole("checkbox").count()).toBe(0);
            const confirm = page.getByRole("button", { name: /Confirm/ });
            await until(async () => (await confirm.isDisabled()) ? null : true, { label: "confirm enabled with zero acks" });
            await confirm.click();
            const tasks = await until(async () => { const ts = await listTasks(page); return ts.length === 1 ? ts : null; }, { timeoutMs: 60_000, label: "1 task queued after confirm" });
            expect(tasks[0].status).toBe("queued");
            await until(() => readdirSync(planDir).length === 0 ? true : null, { label: ".helm/plan/ cleared after confirm" });
        } finally {
            await helm.close();
        }
    });

    // ── Overhaul (2026-07-14) — the persisted-run server gates, driven through the REAL ipc ─────────
    // The renderer can't normally send a stale approve (its panel resets on draft change), so these gates are
    // asserted at the window.helm seam — the same plans:approve every button click lands on: a bogus runId is
    // stale-rejected, a draft edited after the run is stale-rejected, and a double-Confirm inserts exactly once.
    it("approve rejects stale runs and a double-Confirm inserts exactly one plan (window.helm seam)", async () => {
        const { repo, projectId, seed } = seededProject("StaleProj");
        const planDir = join(repo, ".helm", "plan");
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            await pauseFleet(page);
            mkdirSync(planDir, { recursive: true });
            const draft = (title: string) => JSON.stringify({
                planTitle: "stale-accept",
                tasks: [{ slug: "t1", title, intent: "i", acceptance: [{ cmd: "npm run verify:red", role: "proof" }], scopeHint: null, dependsOn: [] }],
            }, null, 2);
            writeFileSync(join(planDir, "tasks.json"), draft("v1"));

            // A real run through the real ipc — REALLY executes verify:red in a throwaway worktree.
            const r1 = await page.evaluate((pid) => window.helm.preflightPlan(pid), projectId);
            if (!r1.ok) throw new Error(`preflight failed: ${r1.errors.join(" · ")}`);
            expect(r1.report.verdicts[0].level).toBe("ok-red");

            // Gate 1: a bogus runId → stale, nothing queued.
            const bogus = await page.evaluate((pid) => window.helm.approvePlan(pid, { runId: "run-bogus", acks: [], skipPreflight: false }), projectId);
            expect(bogus).toMatchObject({ ok: false, stale: true });

            // Gate 2: the draft changes on disk AFTER the run → the stored run's hash no longer matches → stale.
            writeFileSync(join(planDir, "tasks.json"), draft("v2-edited"));
            const stale = await page.evaluate(({ pid, runId }) => window.helm.approvePlan(pid, { runId, acks: [], skipPreflight: false }), { pid: projectId, runId: r1.runId });
            expect(stale).toMatchObject({ ok: false, stale: true });
            expect(await listTasks(page)).toHaveLength(0);

            // Gate 3: re-run against the edited draft, then fire TWO Confirms with the same runId — the run is
            // CONSUMED by the winner; exactly one plan and one task exist afterwards (the ×2-plan lesson).
            const r2 = await page.evaluate((pid) => window.helm.preflightPlan(pid), projectId);
            if (!r2.ok) throw new Error(`preflight re-run failed: ${r2.errors.join(" · ")}`);
            const [a, b] = await page.evaluate(({ pid, runId }) => Promise.all([
                window.helm.approvePlan(pid, { runId, acks: [], skipPreflight: false }),
                window.helm.approvePlan(pid, { runId, acks: [], skipPreflight: false }),
            ]), { pid: projectId, runId: r2.runId });
            expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
            expect(await listTasks(page)).toHaveLength(1);
            expect(await page.evaluate((pid) => window.helm.listPlans(pid), projectId)).toHaveLength(1);
        } finally {
            await helm.close();
        }
    });
});
