// M8.5 acceptance scenarios — board (re-automates the M7/M8 manual "seeded board renders" check) + the
// deliberately-lying NEGATIVE CONTROL. Drives the REAL built app; asserts via window.helm (the prod-safe
// machine-readable agent handle) + visible DOM text. Every scenario try/finally-closes its Electron app;
// a failed launch is a loud FAIL (launchHelm throws), never a skip. No scenario drives a real claude.
import { describe, it, expect } from "vitest";
import { launchHelm, seededNeedsHumanBoard } from "./harness";

describe("board", () => {
    it("renders a seeded project + needs-human task (retained worktree survives boot-reconcile)", async () => {
        const { seed } = seededNeedsHumanBoard();
        const helm = await launchHelm({ seed });
        try {
            // window.helm (machine-readable): the task is present, needs-human, worktree retained.
            const tasks = await helm.page.evaluate(() => window.helm.listTasks());
            expect(tasks.length).toBe(1);
            expect(tasks[0].status).toBe("needs-human"); // boot-reconcile did NOT prune / re-drive it
            expect(tasks[0].worktreePath).not.toBeNull();

            const projects = await helm.page.evaluate(() => window.helm.listProjects());
            expect(projects.map((p) => p.name)).toContain("AcceptProj");

            // The RENDERER drew the card — its title is visible in the DOM (a card only renders in the lane
            // matching its status, so a visible title + status=needs-human ⇒ it's in the needs-human lane).
            await helm.page.getByText("Seeded needs-human task").waitFor({ state: "visible", timeout: 30_000 });
        } finally {
            await helm.close();
        }
    });

    // The self-referential probe (roadmap M8.5 `harness-catches-a-lie`): assert something that CANNOT be
    // true of the observed reality and prove the harness rejects it. An acceptance harness that can't catch
    // a lie is a happy-path replay. The suite stays GREEN by asserting the lie WAS caught.
    it("negative control — the harness CATCHES a deliberately false assertion (must be seen catching it)", async () => {
        const { seed } = seededNeedsHumanBoard();
        const helm = await launchHelm({ seed });
        try {
            // Observe REAL state off the running app: exactly one needs-human task.
            const tasks = await helm.page.evaluate(() => window.helm.listTasks());
            const realCount = tasks.filter((t) => t.status === "needs-human").length;
            expect(realCount).toBe(1); // sanity — we truly read live state, not an assumption
            // The seeded title is really on screen (a real observation to lie against).
            await helm.page.getByText("Seeded needs-human task").waitFor({ state: "visible", timeout: 30_000 });

            // THE LIE: reality has 1 needs-human task; assert it has 2. A real verifier MUST reject this.
            let caught = false;
            try {
                expect(realCount).toBe(2);
            } catch {
                caught = true;
            }
            console.log(`[negative-control] observed needs-human count = ${realCount}; asserted it equals 2 (a deliberate lie) -> harness caught it = ${caught}`);
            expect(caught, "HARNESS BLIND: a deliberately false assertion did NOT fail — this harness is a happy-path replay, not a verifier").toBe(true);
        } finally {
            await helm.close();
        }
    });
});
