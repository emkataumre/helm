// M8.5 acceptance scenarios — the task-detail view (M3 observability cockpit) and the M5 drop-in hand-back
// trio. Backfills the M3/M5 manual UI checks the tracer suite skipped. Drives the built app; asserts via
// visible DOM text. Every scenario try/finally-closes its app. Agent-free by construction: the seeded tasks
// are terminal (merged) or a retaining pause state (handed-off), which the scheduler never auto-starts, and
// no scenario clicks Resume/Verify/Start-fresh (those would run a real loop/merge/claude) — presence only.
import { describe, it, expect } from "vitest";
import { launchHelm, seededMergedBoard, seededNeedsHumanBoard } from "./harness";

describe("detail", () => {
    it("open a merged task → the observability detail renders every section, then ← board returns (M3)", async () => {
        const { title, seed } = seededMergedBoard();
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // The merged card renders in the merged lane; clicking it opens TaskDetail (card onClick).
            await page.getByText(title).waitFor({ state: "visible", timeout: 30_000 });
            await page.getByText(title).click();

            // The snapshot is rebuilt from DB rows (no live engine) — the feed is empty, but every section
            // of the M3 cockpit still renders. Wait past the brief "Loading…" for the Iterations heading.
            await page.getByRole("heading", { name: "Iterations", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
            await page.getByText("Activity feed").waitFor({ state: "visible", timeout: 15_000 });
            await page.getByText("progress.md").waitFor({ state: "visible", timeout: 15_000 });
            const back = page.getByRole("button", { name: "← board", exact: true });
            await back.waitFor({ state: "visible" });

            // ← board returns to the lanes (the card is visible again, the detail's back button is gone).
            await back.click();
            await page.getByText(title).waitFor({ state: "visible", timeout: 15_000 });
            expect(await page.getByRole("button", { name: "← board", exact: true }).count()).toBe(0);
        } finally {
            await helm.close();
        }
    });

    it("a handed-off task shows the hand-back trio in detail and a + terminal on its card (M5)", async () => {
        const { title, seed } = seededNeedsHumanBoard("AcceptProj", "Seeded handed-off task", "handed-off");
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // On the board, a retained handed-off card exposes a "+ terminal" (open a shell in its worktree)
            // but NOT Drop in / Start fresh (those are running/needs-human only) — the trio lives in detail.
            await page.getByText(title).waitFor({ state: "visible", timeout: 30_000 });
            await page.getByRole("button", { name: "+ terminal", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
            expect(await page.getByRole("button", { name: "Start fresh", exact: true }).count()).toBe(0);

            // Open detail → the hand-back trio renders (handed-off only). Assert presence; do NOT click any —
            // Resume loop re-enters the loop and Verify & merge runs a real merge (both out of accept scope).
            await page.getByText(title).click();
            await page.getByRole("button", { name: "Resume loop", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
            await page.getByRole("button", { name: "Verify & merge", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
            await page.getByRole("button", { name: "Abandon", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
        } finally {
            await helm.close();
        }
    });
});
