// M8.5 acceptance scenarios — the task-detail view (M3 observability cockpit) and the M5 drop-in hand-back
// trio. Backfills the M3/M5 manual UI checks the tracer suite skipped. Drives the built app; asserts via
// visible DOM text. Every scenario try/finally-closes its app. Agent-free by construction: the seeded tasks
// are terminal (merged) or a retaining pause state (handed-off), which the scheduler never auto-starts, and
// no scenario clicks Resume/Verify/Start-fresh (those would run a real loop/merge/claude) — presence only.
//
// M14 cockpit deltas: the detail is Feed / Iterations / progress.md tabs beside a 340px inspector; the
// hand-back trio (Resume / Verify & merge / Abandon) is the detail header's verb bar; the card shows the
// first two verbs compactly on hover with the rest behind the task view.
import { describe, it, expect } from "vitest";
import { launchHelm, seededMergedBoard, seededNeedsHumanBoard } from "./harness";

describe("detail", () => {
    it("open a merged task → the observability detail renders every section, then Back returns (M3)", async () => {
        const { title, seed } = seededMergedBoard();
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // The merged card renders in the done column; clicking it opens TaskDetail.
            await page.getByText(title).waitFor({ state: "visible", timeout: 30_000 });
            await page.getByText(title).click();

            // The snapshot is rebuilt from DB rows (no live engine) — the feed is empty, but every tab of
            // the cockpit renders: Feed (empty-state copy names the durable home), Iterations, progress.md,
            // and the inspector's sections (acceptance / bounds).
            await page.getByRole("tab", { name: "Feed" }).waitFor({ state: "visible", timeout: 30_000 });
            await page.getByText("history lives in Iterations").waitFor({ state: "visible", timeout: 15_000 });
            await page.getByRole("tab", { name: "Iterations" }).click();
            await page.getByText("No iterations yet.").waitFor({ state: "visible", timeout: 15_000 });
            await page.getByRole("tab", { name: "progress.md" }).click();
            await page.getByText("No progress file — the worktree is gone.").waitFor({ state: "visible", timeout: 15_000 });
            await page.getByText("acceptance — the per-task gate").waitFor({ state: "visible", timeout: 15_000 });

            // Back returns to the project board (the card is visible again, the detail's back button gone).
            const back = page.getByRole("button", { name: "Back", exact: true });
            await back.waitFor({ state: "visible" });
            await back.click();
            await page.getByText(title).waitFor({ state: "visible", timeout: 15_000 });
            expect(await page.getByRole("button", { name: "Back", exact: true }).count()).toBe(0);
        } finally {
            await helm.close();
        }
    });

    it("a handed-off task shows the hand-back trio in detail and its compact verbs on the card (M5)", async () => {
        const { title, seed } = seededNeedsHumanBoard("AcceptProj", "Seeded handed-off task", "handed-off");
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // On the board, a handed-off card's compact verbs are the first two of the trio — Resume and
            // Verify & merge — but NOT Drop in / Start fresh (those are running/needs-human only).
            const card = page.locator(".helm-task-card").filter({ hasText: title });
            await card.waitFor({ state: "visible", timeout: 30_000 });
            await card.hover();
            await card.getByRole("button", { name: "Resume", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
            await card.getByRole("button", { name: "Verify & merge", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
            expect(await card.getByRole("button", { name: "Start fresh", exact: true }).count()).toBe(0);
            expect(await card.getByRole("button", { name: "Drop in", exact: true }).count()).toBe(0);

            // Open detail → the FULL verb bar renders (handed-off: Resume / Verify & merge / Open shell /
            // Abandon). Assert presence; do NOT click any — Resume re-enters the loop and Verify & merge
            // runs a real merge (both out of accept scope).
            await card.click();
            await page.getByRole("button", { name: "Resume", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
            await page.getByRole("button", { name: "Verify & merge", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
            await page.getByRole("button", { name: "Open shell", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
            await page.getByRole("button", { name: "Abandon", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
        } finally {
            await helm.close();
        }
    });
});
