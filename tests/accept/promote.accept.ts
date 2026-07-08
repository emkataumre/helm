// M8.5 acceptance scenario — the M6-③ project-level batch Promote UI. Backfills the M6 manual promote
// check. Drives the built app against a REAL bare origin (integration == main, so the whole promote path
// runs over real git: fetch origin/<target>, count commits beyond it → nothing-to-promote). This exercises
// the button → dialog → validate → PromoteOutcome wiring end to end while PUSHING NOTHING to the target —
// the nothing-to-promote outcome returns before finalize, so the never-push-target invariant holds by
// construction. Agent-free: promote never spawns a claude. try/finally-closes the app.
//
// M14 cockpit delta: Promote is a header verb on the project view that opens a dialog; the human clicks
// "Validate & promote" explicitly and the outcome renders in the same dialog.
import { describe, it } from "vitest";
import { launchHelm, seededPromotableProject, until } from "./harness";

describe("promote", () => {
    it("Promote on a project whose integration has nothing beyond target → nothing-to-promote (M6-③)", async () => {
        const { seed } = seededPromotableProject("PromoteProj");
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // Navigate to the project view; its header carries the Promote verb.
            await page.locator(".helm-sidebar").getByText("PromoteProj").click();
            await page.getByRole("button", { name: "Promote", exact: true }).click();

            // The dialog explains the mode (seeded `pr`) and validates only on the explicit click.
            const dlg = page.locator(".helm-dialog");
            await dlg.getByText("pr mode", { exact: false }).waitFor({ state: "visible", timeout: 15_000 });
            await dlg.getByRole("button", { name: "Validate & promote", exact: true }).click();

            // The real promote stage runs (fetch origin/main, rev-list integration beyond origin/main = 0).
            // until() covers the real-git latency; a non-launching/hung promote surfaces as a loud timeout.
            await until(async () => (await dlg.getByText(/Nothing to promote/).count()) > 0, { timeoutMs: 60_000, label: "promote outcome = nothing-to-promote" });
        } finally {
            await helm.close();
        }
    });
});
