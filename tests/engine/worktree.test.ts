// tests/engine/worktree.test.ts
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/main/engine/exec";
import { ensureBranch, checkoutBranch, createWorktree, removeWorktree } from "../../src/main/engine/worktree";

async function tempRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "helm-wt-"));
    await run("git", ["-C", dir, "init", "-b", "main"]);
    await run("git", ["-C", dir, "config", "user.email", "t@t.t"]);
    await run("git", ["-C", dir, "config", "user.name", "t"]);
    await run("git", ["-C", dir, "commit", "--allow-empty", "-m", "init"]);
    return dir;
}

it("creates a branch, a worktree on it, then removes both", async () => {
    const repo = await tempRepo();
    try {
        await ensureBranch(repo, "integration/ralph", "main");
        await checkoutBranch(repo, "integration/ralph");
        const wt = await createWorktree(repo, "integration/ralph", "ralph/task-1", ".helm/worktrees");
        expect(existsSync(wt)).toBe(true);
        await removeWorktree(repo, wt, "ralph/task-1", false);
        expect(existsSync(wt)).toBe(false);
        const branches = await run("git", ["-C", repo, "branch", "--list", "ralph/task-1"]);
        expect(branches.stdout.trim()).toBe("");
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});

// M4 PROBE: parallel first-run. Three tasks boot at once and all call ensureBranch on the
// not-yet-existing integration branch, then each `git worktree add` — repo-level git mutations that
// race (fatal: branch 'integration/ralph' already exists; index.lock contention). They must be
// serialized per repo so every task gets its worktree, not just the one that won the race.
it("M4: concurrent ensureBranch + createWorktree on a fresh repo don't race", async () => {
    const repo = await tempRepo();
    try {
        await Promise.all([0, 1, 2].map(() => ensureBranch(repo, "integration/ralph", "main")));
        const wts = await Promise.all([1, 2, 3].map((n) =>
            createWorktree(repo, "integration/ralph", `ralph/task-${n}`, ".helm/worktrees")));
        for (const wt of wts) expect(existsSync(wt)).toBe(true);
        await Promise.all(wts.map((wt, i) => removeWorktree(repo, wt, `ralph/task-${i + 1}`, false)));
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
