// tests/engine/merge.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/main/engine/exec";
import { commitAll, squashMergeInto, diffStat } from "../../src/main/engine/merge";

async function tempRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "helm-merge-"));
    await run("git", ["-C", dir, "init", "-b", "integration"]);
    await run("git", ["-C", dir, "config", "user.email", "t@t.t"]);
    await run("git", ["-C", dir, "config", "user.name", "t"]);
    await run("git", ["-C", dir, "commit", "--allow-empty", "-m", "init"]);
    return dir;
}

it("commits all changes, then squash-merges a branch into integration as one commit", async () => {
    const repo = await tempRepo();
    try {
        await run("git", ["-C", repo, "checkout", "-b", "ralph/task-1"]);
        writeFileSync(join(repo, "a.txt"), "hello\n");
        await commitAll(repo, "ralph: task work");
        const diff = await diffStat(repo, "integration", "ralph/task-1");
        expect(diff).toBe("+1 -0");

        await run("git", ["-C", repo, "checkout", "integration"]);
        const res = await squashMergeInto(repo, "ralph/task-1", "integration");
        expect(res).toEqual({ merged: true, conflict: false });

        const log = await run("git", ["-C", repo, "log", "--oneline", "integration"]);
        expect(log.stdout).toContain("ralph: merge ralph/task-1");
        const parents = await run("git", ["-C", repo, "rev-list", "--parents", "-n", "1", "HEAD"]);
        // squash => single-parent commit (2 hashes on the line), not a merge commit (3)
        expect(parents.stdout.trim().split(/\s+/).length).toBe(2);
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});

it("commitAll is a no-op when the tree is clean", async () => {
    const repo = await tempRepo();
    try { await commitAll(repo, "nothing"); } finally { rmSync(repo, { recursive: true, force: true }); }
});
