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
