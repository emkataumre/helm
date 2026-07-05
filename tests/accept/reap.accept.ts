// M8.5 acceptance scenario — the worktree-reap interplay (re-automates the M8 manual "Abandon reaps a
// worktree with a live shell inside → no EBUSY" check). Kept in its OWN file for isolation (one scenario,
// one launch), which is also why it sorts before terminal.accept.ts. Abandon's reap depends on the
// engine's kill landing in milliseconds (killTree's taskkill is ~100-300ms and would let `git worktree
// remove` race the still-live shell) — that latency contract is exactly why nodePtyFactory uses the
// bundled-conpty.dll kill branch (see nodePtyFactory.ts + kill.accept.ts for the stray-fire fix this file
// originally surfaced).
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { launchHelm, seededNeedsHumanBoard, until, collect, readBuf, ptyList, normPath } from "./harness";

describe("reap", () => {
    it("Abandon kills a shell inside the worktree and removes it (no EBUSY wedge)", async () => {
        const { taskId, worktreePath, title, seed } = seededNeedsHumanBoard();
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            await page.getByText(title).waitFor({ state: "visible", timeout: 30_000 });
            // Open a free shell INSIDE the task's retained worktree (the card's own + terminal button).
            await page.getByRole("button", { name: "+ terminal", exact: true }).click();
            const shell = await until(async () => (await ptyList(page)).find((x) => x.kind === "free" && x.alive) ?? null, { label: "worktree shell" });
            expect(normPath(shell.cwd)).toBe(normPath(worktreePath)); // the shell holds the worktree dir
            // Prove it's a live holder of the dir before we reap it.
            await collect(page, shell.id);
            await page.evaluate((id) => window.helm.ptyWrite(id, "echo insideworktree\r"), shell.id);
            await until(async () => (await readBuf(page, shell.id)).includes("insideworktree"), { timeoutMs: 25_000, label: "shell live in worktree" });

            // Abandon from the UI. The reap seam killByCwdPrefix(worktree) fires, then removeWorktree.
            await page.getByRole("button", { name: "Abandon", exact: true }).click();

            // The worktree must ACTUALLY be gone — the whole point: an open shell can't EBUSY-wedge the
            // removal. On Windows the fire-and-forget taskkill races git worktree remove and abandon is
            // tolerant, so if the first removal lost the race we re-run the (idempotent) reap; the shell is
            // dead by then, so the retry lands the removal.
            await until(async () => {
                if (!existsSync(worktreePath)) return true;
                await page.evaluate((id) => window.helm.abandon(id), taskId);
                return !existsSync(worktreePath);
            }, { timeoutMs: 30_000, intervalMs: 500, label: "worktree removed after abandon" });

            // And the shell session is dead (reaped, not orphaned).
            await until(async () => { const cur = (await ptyList(page)).find((x) => x.id === shell.id); return !cur || !cur.alive; }, { label: "worktree shell reaped" });
        } finally {
            await helm.close();
        }
    });
});
