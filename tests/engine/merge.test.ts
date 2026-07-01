// tests/engine/merge.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/main/engine/exec";
import { commitAll, squashMergeInto, diffStat, headSha, advanceBranch, fetchRemote, countCommitsBeyond, mergeNoFf, pushBranch } from "../../src/main/engine/merge";
import type { ExecFn } from "../../src/main/engine/exec";

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

describe("advanceBranch (real git)", () => {
    it("force-moves a branch ref to a target commit (integration ends at the validated tip)", async () => {
        const repo = await tempRepo(); // on branch "integration" with one empty commit
        try {
            // A temp branch off integration with one extra commit — the validated merge tip.
            await run("git", ["-C", repo, "checkout", "-b", "helm/merge-x", "integration"]);
            writeFileSync(join(repo, "x.txt"), "x\n");
            await commitAll(repo, "merged work");
            const tip = await headSha(repo);
            // Move back so "integration" is not the checked-out branch (it's advanced as a ref).
            await run("git", ["-C", repo, "checkout", "helm/merge-x"]);

            await advanceBranch(repo, "integration", tip);

            const moved = await run("git", ["-C", repo, "rev-parse", "integration"]);
            expect(moved.stdout.trim()).toBe(tip);
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("throws when the target commitish is invalid", async () => {
        const repo = await tempRepo();
        try {
            await run("git", ["-C", repo, "branch", "feature", "integration"]);
            await expect(advanceBranch(repo, "feature", "no-such-commit")).rejects.toThrow();
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });
});

describe("headSha", () => {
    it("returns the trimmed HEAD sha of the given repo/worktree", async () => {
        const exec: ExecFn = async (_cmd, args) => {
            expect(args).toEqual(["-C", "/wt", "rev-parse", "HEAD"]);
            return { code: 0, stdout: "abc123\n", stderr: "", timedOut: false };
        };
        expect(await headSha("/wt", exec)).toBe("abc123");
    });
});

// ── M6-③ promotion primitives ──────────────────────────────────────────────────────────────────
// A repo on `main` with one base commit — the substrate for the real-git behaviours below.
async function mainRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "helm-promote-"));
    await run("git", ["-C", dir, "init", "-b", "main"]);
    await run("git", ["-C", dir, "config", "user.email", "t@t.t"]);
    await run("git", ["-C", dir, "config", "user.name", "t"]);
    writeFileSync(join(dir, "base.txt"), "base\n");
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "commit", "-m", "base"]);
    return dir;
}

describe("fetchRemote", () => {
    it("runs `git -C <repo> fetch <remote> <branch>`", async () => {
        const exec: ExecFn = async (_cmd, args) => {
            expect(args).toEqual(["-C", "/repo", "fetch", "origin", "main"]);
            return { code: 0, stdout: "", stderr: "", timedOut: false };
        };
        await expect(fetchRemote("/repo", "origin", "main", exec)).resolves.toBeUndefined();
    });
    it("throws when the fetch fails (so a stale target can't masquerade as fresh)", async () => {
        const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "no such remote", timedOut: false });
        await expect(fetchRemote("/repo", "origin", "main", exec)).rejects.toThrow(/fetch/);
    });
});

describe("countCommitsBeyond (real git)", () => {
    it("counts commits in base..tip; returns 0 when tip has nothing beyond base", async () => {
        const repo = await mainRepo();
        try {
            // A tip branch two commits ahead of main.
            await run("git", ["-C", repo, "checkout", "-b", "tip"]);
            writeFileSync(join(repo, "a.txt"), "a\n");
            await commitAll(repo, "a");
            writeFileSync(join(repo, "b.txt"), "b\n");
            await commitAll(repo, "b");

            expect(await countCommitsBeyond(repo, "main", "tip")).toBe(2);
            expect(await countCommitsBeyond(repo, "tip", "tip")).toBe(0); // nothing beyond itself
            expect(await countCommitsBeyond(repo, "tip", "main")).toBe(0); // main is behind, not ahead
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });
});

describe("mergeNoFf (real git)", () => {
    it("merges a diverged branch with a real merge commit (two parents) on a clean merge", async () => {
        const repo = await mainRepo();
        try {
            await run("git", ["-C", repo, "checkout", "-b", "integration"]);
            writeFileSync(join(repo, "int.txt"), "int\n");
            await commitAll(repo, "int work");
            await run("git", ["-C", repo, "checkout", "main"]);
            writeFileSync(join(repo, "main.txt"), "main\n"); // divergence, different file → no conflict
            await commitAll(repo, "main work");

            const res = await mergeNoFf(repo, "integration");
            expect(res).toEqual({ merged: true, conflict: false });

            const parents = await run("git", ["-C", repo, "rev-list", "--parents", "-n", "1", "HEAD"]);
            expect(parents.stdout.trim().split(/\s+/).length).toBe(3); // --no-ff ⇒ merge commit (self + 2 parents)
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("on a textual conflict, aborts the merge and reports conflict, leaving the worktree clean", async () => {
        const repo = await mainRepo();
        try {
            await run("git", ["-C", repo, "checkout", "-b", "integration"]);
            writeFileSync(join(repo, "clash.txt"), "int\n");
            await commitAll(repo, "int clash");
            await run("git", ["-C", repo, "checkout", "main"]);
            writeFileSync(join(repo, "clash.txt"), "main\n"); // same file, different content → conflict
            await commitAll(repo, "main clash");
            const before = await headSha(repo);

            const res = await mergeNoFf(repo, "integration");
            expect(res).toEqual({ merged: false, conflict: true });

            const status = await run("git", ["-C", repo, "status", "--porcelain"]);
            expect(status.stdout.trim()).toBe(""); // --abort restored a clean tree (no lingering conflict markers)
            expect(await headSha(repo)).toBe(before); // HEAD unmoved — nothing landed
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });
});

describe("pushBranch (argv shape — the only push primitive)", () => {
    it("pushes a plain local ref: `git push <remote> <localRef>`", async () => {
        const seen: string[][] = [];
        const exec: ExecFn = async (_cmd, args) => { seen.push(args!); return { code: 0, stdout: "", stderr: "", timedOut: false }; };
        await pushBranch("/repo", "origin", "integration/ralph", undefined, exec);
        expect(seen[0]).toEqual(["-C", "/repo", "push", "origin", "integration/ralph"]);
    });
    it("pushes a colon refspec when a remoteRef is given (the raw-sha → refs/heads/target shape)", async () => {
        const seen: string[][] = [];
        const exec: ExecFn = async (_cmd, args) => { seen.push(args!); return { code: 0, stdout: "", stderr: "", timedOut: false }; };
        await pushBranch("/repo", "origin", "deadbeef", "refs/heads/main", exec);
        expect(seen[0]).toEqual(["-C", "/repo", "push", "origin", "deadbeef:refs/heads/main"]);
    });
    it("throws when the push fails", async () => {
        const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "rejected", timedOut: false });
        await expect(pushBranch("/repo", "origin", "helm/promote-x", undefined, exec)).rejects.toThrow(/push/);
    });
});
