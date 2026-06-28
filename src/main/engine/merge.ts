// src/main/engine/merge.ts
import { run, type ExecFn } from "./exec";

async function git(repoRoot: string, args: string[], exec: ExecFn) {
    return exec("git", ["-C", repoRoot, ...args]);
}

export async function commitAll(repoRoot: string, message: string, exec: ExecFn = run): Promise<void> {
    await git(repoRoot, ["add", "-A"], exec);
    const status = await git(repoRoot, ["status", "--porcelain"], exec);
    if (status.stdout.trim() === "") return;
    const res = await git(repoRoot, ["commit", "-m", message], exec);
    if (res.code !== 0) throw new Error(`Helm: git commit failed: ${res.stderr.trim()}`);
}

// Squash-merge a task branch into the (checked-out) target as a single commit. Caller guarantees
// repoRoot is on `target`. On conflict, hard-reset the index/worktree so target stays clean.
export async function squashMergeInto(
    repoRoot: string,
    taskBranch: string,
    target: string,
    exec: ExecFn = run,
): Promise<{ merged: boolean; conflict: boolean }> {
    const sq = await git(repoRoot, ["merge", "--squash", taskBranch], exec);
    if (sq.code !== 0) {
        await git(repoRoot, ["reset", "--hard", "HEAD"], exec);
        return { merged: false, conflict: true };
    }
    const status = await git(repoRoot, ["status", "--porcelain"], exec);
    if (status.stdout.trim() === "") return { merged: true, conflict: false }; // nothing to merge
    const c = await git(repoRoot, ["commit", "-m", `ralph: merge ${taskBranch}`], exec);
    if (c.code !== 0) { await git(repoRoot, ["reset", "--hard", "HEAD"], exec); return { merged: false, conflict: true }; }
    return { merged: true, conflict: false };
}

export async function diffStat(repoRoot: string, base: string, branch: string, exec: ExecFn = run): Promise<string> {
    const res = await git(repoRoot, ["diff", "--shortstat", `${base}...${branch}`], exec);
    if (res.code !== 0) return "";
    const ins = res.stdout.match(/(\d+) insertion/);
    const del = res.stdout.match(/(\d+) deletion/);
    return `+${ins?.[1] ?? 0} -${del?.[1] ?? 0}`;
}
