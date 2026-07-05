// M8.5 acceptance scenario — the M6-③ project-level batch Promote UI. Backfills the M6 manual promote
// check. Drives the built app against a REAL bare origin (integration == main, so the whole promote path
// runs over real git: fetch origin/<target>, count commits beyond it → nothing-to-promote). This exercises
// the button → loading → PromoteResultPanel wiring end to end while PUSHING NOTHING to the target — the
// nothing-to-promote outcome returns before finalize, so the never-push-target invariant holds by
// construction. Agent-free: promote never spawns a claude. try/finally-closes the app.
import { describe, it } from "vitest";
import { launchHelm, seededPromotableProject, until } from "./harness";

describe("promote", () => {
    it("Promote on a project whose integration has nothing beyond target → nothing-to-promote (M6-③)", async () => {
        const { seed } = seededPromotableProject("PromoteProj");
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // The Promote strip renders a per-project button "<name> (<mode>)"; the seeded project is `pr`.
            const btn = page.getByRole("button", { name: "PromoteProj (pr)", exact: true });
            await btn.waitFor({ state: "visible", timeout: 30_000 });
            await btn.click();

            // The real promote stage runs (fetch origin/main, rev-list integration beyond origin/main = 0).
            // The result panel shows the outcome code + the human-readable body. until() covers the real-git
            // latency; a non-launching/hung promote would surface as a loud timeout, never a silent pass.
            await until(async () => (await page.getByText("nothing-to-promote").count()) > 0, { timeoutMs: 60_000, label: "promote outcome = nothing-to-promote" });
            await page.getByText(/Nothing to promote/).waitFor({ state: "visible", timeout: 15_000 });
        } finally {
            await helm.close();
        }
    });
});
