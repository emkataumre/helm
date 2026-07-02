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

// Read the HEAD commit sha of a repo/worktree. The no-progress breaker compares this across
// iterations: an unchanged sha means commitAll no-op'd (clean tree) → the agent did nothing.
export async function headSha(repoRoot: string, exec: ExecFn = run): Promise<string> {
    const res = await git(repoRoot, ["rev-parse", "HEAD"], exec);
    return res.stdout.trim();
}

// ── M6-③ promotion primitives (spec §13) ────────────────────────────────────────────────────────
// The reads/mutations the project-level batch Promote needs, ExecFn-injected like the rest so the pure
// promote stage unit-tests with fakes. Siblings of the M4 merge helpers, not overloads of them.

// Refresh <remote>/<branch> so the promotion validates against a FRESH target tip (the whole point of
// re-checking on origin/<targetBranch>). Throws on failure so a stale target can't masquerade as fresh.
export async function fetchRemote(repoRoot: string, remote: string, branch: string, exec: ExecFn = run): Promise<void> {
    const res = await git(repoRoot, ["fetch", remote, branch], exec);
    if (res.code !== 0) throw new Error(`Helm: git fetch ${remote} ${branch} failed: ${res.stderr.trim()}`);
}

// How many commits <tip> has that <base> does not (`git rev-list --count base..tip`). 0 ⇒ integration
// holds nothing beyond the target → nothing to promote. Throws on a bad ref (a fetch precedes it, so the
// refs exist; failing loud beats silently reading 0 = "nothing to promote" when we actually couldn't check).
export async function countCommitsBeyond(repoRoot: string, base: string, tip: string, exec: ExecFn = run): Promise<number> {
    const res = await git(repoRoot, ["rev-list", "--count", `${base}..${tip}`], exec);
    if (res.code !== 0) throw new Error(`Helm: git rev-list --count ${base}..${tip} failed: ${res.stderr.trim()}`);
    return Number(res.stdout.trim()) || 0;
}

// Resolve a ref (branch, remote-tracking ref, tag) to its full commit sha (`git rev-parse <ref>`). The
// promote stage uses this to read the integration tip sha for the UNIQUE throwaway branch name
// `helm/promote-<projectId>-<integrationShortSha>` (integration is checked out nowhere, so headSha — which
// reads a worktree's HEAD — can't reach it). Throws on a bad ref.
export async function revParse(repoRoot: string, ref: string, exec: ExecFn = run): Promise<string> {
    const res = await git(repoRoot, ["rev-parse", ref], exec);
    if (res.code !== 0) throw new Error(`Helm: git rev-parse ${ref} failed: ${res.stderr.trim()}`);
    return res.stdout.trim();
}

// A --no-ff --no-edit merge of <ref> into the worktree's checked-out branch, preserving the integration
// history as a real merge commit. --no-edit kills the editor-abort footgun spec §13 calls out. On ANY
// merge failure (conflict or otherwise) we `git merge --abort` and report conflict — the promote stage
// then bails without advancing anything, so a messy tree never survives.
export async function mergeNoFf(worktreePath: string, ref: string, exec: ExecFn = run): Promise<{ merged: boolean; conflict: boolean }> {
    const res = await git(worktreePath, ["merge", "--no-ff", "--no-edit", ref], exec);
    if (res.code !== 0) {
        await git(worktreePath, ["merge", "--abort"], exec); // restore a clean tree; ignore its result
        return { merged: false, conflict: true };
    }
    return { merged: true, conflict: false };
}

// THE only push primitive (the never-push invariant hangs off this): `git push <remote> <localRef>` or,
// with a remoteRef, the colon refspec `git push <remote> <localRef>:<remoteRef>` (used for the raw-sha →
// refs/heads/<target> shape direct mode hands the human). The verify slice asserts finalizePromotion
// NEVER calls this with the target branch as remoteRef; pushBranch itself is a neutral wrapper.
export async function pushBranch(repoRoot: string, remote: string, localRef: string, remoteRef?: string, exec: ExecFn = run): Promise<void> {
    const refspec = remoteRef ? `${localRef}:${remoteRef}` : localRef;
    const res = await git(repoRoot, ["push", remote, refspec], exec);
    if (res.code !== 0) throw new Error(`Helm: git push ${remote} ${refspec} failed: ${res.stderr.trim()}`);
}

// Atomically force a branch ref to a commit (`git branch -f`). The M4 merge stage uses this to
// advance the integration branch to a validated merge tip. Safe ONLY because integration is checked
// out NOWHERE during normal operation (the merge happens in a throwaway worktree on a temp branch),
// so this is a pure ref update — integration never holds an unvalidated commit (we re-check first).
export async function advanceBranch(repoRoot: string, branch: string, toCommitish: string, exec: ExecFn = run): Promise<void> {
    const res = await git(repoRoot, ["branch", "-f", branch, toCommitish], exec);
    if (res.code !== 0) throw new Error(`Helm: git branch -f ${branch} ${toCommitish} failed: ${res.stderr.trim()}`);
}
