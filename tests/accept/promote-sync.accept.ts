// Acceptance scenario — direct-promote auto-syncs local integration + <target> to the fresh trunk.
// THE DEFINITIVE live proof for the promote-sync task (the promotesync verify slice is fakes; this is
// real git): a direct-mode project on a scratch repo with integration ONE COMMIT AHEAD of main and a
// LOCAL BARE origin remote. Promote via the real UI (button → dialog → Validate & promote), then assert
// against REAL git that
//   • origin/main ADVANCED (the bare remote's main moved off the seeded tip), and
//   • local integration/ralph == local main == the validated commit (the auto-sync landed both), and
//   • the validated commit's --no-ff second parent IS the promoted integration tip (nothing else snuck in).
// The only push in the whole flow is the target advance to the LOCAL bare origin — no network, and the
// never-push invariant over real refs is exactly what the final assertions read back. Agent-free:
// promote never spawns a claude. try/finally-closes the app.
//
// Seeding: the base-schema seed carries no promotionMode column (the app's migrate() adds it on boot),
// so the scenario flips the project to direct mode over the real window.helm bridge after launch.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { launchHelm, makeTargetRepo, makeOrigin, tmp, until } from "./harness";
import { seedProjectSql } from "./seed";

const git = (cwd: string, args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

// A promotable DIRECT-mode fixture: a real target repo whose integration/ralph carries one commit main
// does not, plus a real bare origin holding both (makeOrigin pushes main + integration). main stays
// checked out in the repo — so the local-target fast-forward exercises the checked-out working-copy path.
function seededSyncProject(name: string): { repo: string; origin: string; projectId: string; seed: string[] } {
    const repo = tmp("repo");
    makeTargetRepo(repo);
    git(repo, ["switch", "integration/ralph"]);
    writeFileSync(join(repo, "feature.txt"), "work graduated by the promote\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "feat: integration work beyond main"]);
    git(repo, ["switch", "main"]);
    const origin = makeOrigin(repo);
    const projectId = randomUUID();
    return { repo, origin, projectId, seed: [seedProjectSql({ id: projectId, name, repoPath: repo })] };
}

describe("promote-sync", () => {
    it("direct Promote advances origin/main AND auto-syncs local integration + main to the validated commit", async () => {
        const { repo, origin, projectId, seed } = seededSyncProject("PromoteSyncProj");
        const mainBefore = git(repo, ["rev-parse", "main"]);
        const promotedIntegrationTip = git(repo, ["rev-parse", "integration/ralph"]);
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // Flip the seeded project to direct mode over the real bridge; the tasks:changed nudge
            // re-fetches projects, so the dialog below renders the direct-mode blurb once it lands.
            await page.evaluate((id) => window.helm.updateProject(id, { promotionMode: "direct" }), projectId);

            await page.locator(".helm-sidebar").getByText("PromoteSyncProj").click();
            await page.getByRole("button", { name: "Promote", exact: true }).click();
            const dlg = page.locator(".helm-dialog");
            await dlg.getByText("direct mode", { exact: false }).waitFor({ state: "visible", timeout: 15_000 });
            await dlg.getByRole("button", { name: "Validate & promote", exact: true }).click();

            // The REAL promote runs (fetch origin/main, --no-ff merge in a throwaway worktree, re-run
            // `npm run check` there) — minutes-scale budget, a hung promote surfaces as a loud timeout.
            await until(async () => (await dlg.getByText(/advanced main/).count()) > 0, { timeoutMs: 180_000, label: "promote outcome = advanced main" });
            // The sync outcome is surfaced in the same dialog (integration reset + local main ff'd).
            await until(async () => (await dlg.getByText(/integration\/ralph fast-forwarded/).count()) > 0, { timeoutMs: 15_000, label: "sync note: integration fast-forwarded" });
            await until(async () => (await dlg.getByText(/local main fast-forwarded/).count()) > 0, { timeoutMs: 15_000, label: "sync note: local main fast-forwarded" });

            // THE definitive proof — REAL git, read straight off the refs:
            const originMain = git(origin, ["rev-parse", "main"]);          // the bare remote's main
            const localMain = git(repo, ["rev-parse", "main"]);
            const localIntegration = git(repo, ["rev-parse", "integration/ralph"]);
            expect(originMain).not.toBe(mainBefore);                        // the target REALLY advanced
            expect(localMain).toBe(originMain);                             // local main ff'd to the validated commit
            expect(localIntegration).toBe(originMain);                      // integration reset to the validated commit
            // …and that commit is the --no-ff merge whose second parent is exactly the promoted tip.
            expect(git(repo, ["rev-parse", `${originMain}^2`])).toBe(promotedIntegrationTip);
            // The working copy fast-forward was real (main is checked out): the merged file is on disk.
            expect(git(repo, ["rev-parse", "HEAD"])).toBe(originMain);
        } finally {
            await helm.close();
        }
    });
});
