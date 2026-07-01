// src/main/engine/worktree.ts
import { join } from "node:path";
import { run, type ExecFn } from "./exec";
import { createKeyedMutex } from "./mutex";
import type { WorktreeInfo } from "./reconcile";

// Repo-level git mutations are NOT concurrency-safe. Under M4's parallel first-run, N tasks boot at
// once and all race to create the integration branch ("fatal: branch 'integration/ralph' already
// exists"), and `git worktree add` contends on `.git/index.lock`. Serialize these brief ops per repo
// (key = repoRoot) so each task gets its branch/worktree — the long-running in-worktree work (agent,
// check, acceptance) is NOT here, so it still runs fully in parallel.
const repoLock = createKeyedMutex();

function sanitize(branch: string): string {
    return branch.replace(/[^a-zA-Z0-9._-]/g, "-");
}

// The canonical on-disk location for a branch's worktree: <repoRoot>/<worktreeDir>/<sanitized-branch>.
// Single source of truth shared by createWorktree (-b, fresh) and the M6 rebuild executor
// (addWorktreeForBranch, from a surviving branch) so both land at the same path.
export function worktreePathFor(repoRoot: string, worktreeDir: string, branch: string): string {
    return join(repoRoot, worktreeDir, sanitize(branch));
}

async function git(repoRoot: string, args: string[], exec: ExecFn): Promise<string> {
    const r = await exec("git", ["-C", repoRoot, ...args]);
    if (r.code !== 0) throw new Error(`Helm: git ${args.join(" ")} failed: ${r.stderr.trim()}`);
    return r.stdout;
}

export async function ensureBranch(repoRoot: string, name: string, createFrom: string, exec: ExecFn = run): Promise<void> {
    await repoLock.withLock(repoRoot, async () => {
        const check = await exec("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", name]);
        if (check.code === 0) return;
        const res = await exec("git", ["-C", repoRoot, "branch", name, createFrom]);
        if (res.code === 0) return;
        // Belt-and-suspenders beyond the lock: if anything created it between our check and create,
        // the postcondition (branch exists) still holds — tolerate rather than fail the task.
        const recheck = await exec("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", name]);
        if (recheck.code === 0) return;
        throw new Error(`Helm: git branch ${name} ${createFrom} failed: ${res.stderr.trim()}`);
    });
}

export async function checkoutBranch(repoRoot: string, name: string, exec: ExecFn = run): Promise<void> {
    await git(repoRoot, ["checkout", name], exec);
}

export async function createWorktree(repoRoot: string, fromBranch: string, branch: string, worktreeDir: string, exec: ExecFn = run): Promise<string> {
    const path = worktreePathFor(repoRoot, worktreeDir, branch);
    await repoLock.withLock(repoRoot, () => git(repoRoot, ["worktree", "add", "-b", branch, path, fromBranch], exec));
    return path;
}

export async function removeWorktree(repoRoot: string, worktreePath: string, branch: string, keepBranch: boolean, exec: ExecFn = run): Promise<void> {
    await repoLock.withLock(repoRoot, async () => {
        await git(repoRoot, ["worktree", "remove", "--force", worktreePath], exec);
        if (!keepBranch) await git(repoRoot, ["branch", "-D", branch], exec);
    });
}

// ── M6 ① boot-reconcile git-state primitives ─────────────────────────────────────────────────────
// The read + rebuild ops the reconcile executor needs. Reads DON'T take the repoLock (they don't mutate
// .git); addWorktreeForBranch does (it contends on .git/index.lock like the other mutations).

// Parse `git worktree list --porcelain`: blocks of `worktree <path>` / `HEAD <sha>` /
// `branch refs/heads/<name>` (or `detached`), separated by blank lines. Returns EVERY worktree
// (including the primary checkout); the executor filters to those under worktreeDir. NOTE: git prints
// paths with forward slashes even on Windows — the planner normalises before comparing.
export async function listWorktrees(repoRoot: string, exec: ExecFn = run): Promise<WorktreeInfo[]> {
    const out = await git(repoRoot, ["worktree", "list", "--porcelain"], exec);
    const result: WorktreeInfo[] = [];
    let current: WorktreeInfo | null = null;
    for (const line of out.split(/\r?\n/)) {
        if (line.startsWith("worktree ")) {
            if (current) result.push(current);
            current = { path: line.slice("worktree ".length), branch: null };
        } else if (line.startsWith("branch ") && current) {
            current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
        }
        // `detached` (and the blank block separator) leave branch = null.
    }
    if (current) result.push(current);
    return result;
}

// All local branch short-names (`ralph/task-*`, `integration/ralph`, `helm/*`, …).
export async function listBranches(repoRoot: string, exec: ExecFn = run): Promise<string[]> {
    const out = await git(repoRoot, ["branch", "--format=%(refname:short)"], exec);
    return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

// The rebuild primitive: recreate a worktree on an ALREADY-EXISTING branch (no `-b`, unlike
// createWorktree). Used when a crash left the task's branch alive but its worktree gone.
export async function addWorktreeForBranch(repoRoot: string, path: string, branch: string, exec: ExecFn = run): Promise<void> {
    await repoLock.withLock(repoRoot, () => git(repoRoot, ["worktree", "add", path, branch], exec));
}
