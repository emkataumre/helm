// src/main/engine/worktree.ts
import { join } from "node:path";
import { run, type ExecFn } from "./exec";
import { createKeyedMutex } from "./mutex";

// Repo-level git mutations are NOT concurrency-safe. Under M4's parallel first-run, N tasks boot at
// once and all race to create the integration branch ("fatal: branch 'integration/ralph' already
// exists"), and `git worktree add` contends on `.git/index.lock`. Serialize these brief ops per repo
// (key = repoRoot) so each task gets its branch/worktree — the long-running in-worktree work (agent,
// check, acceptance) is NOT here, so it still runs fully in parallel.
const repoLock = createKeyedMutex();

function sanitize(branch: string): string {
    return branch.replace(/[^a-zA-Z0-9._-]/g, "-");
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
    const path = join(repoRoot, worktreeDir, sanitize(branch));
    await repoLock.withLock(repoRoot, () => git(repoRoot, ["worktree", "add", "-b", branch, path, fromBranch], exec));
    return path;
}

export async function removeWorktree(repoRoot: string, worktreePath: string, branch: string, keepBranch: boolean, exec: ExecFn = run): Promise<void> {
    await repoLock.withLock(repoRoot, async () => {
        await git(repoRoot, ["worktree", "remove", "--force", worktreePath], exec);
        if (!keepBranch) await git(repoRoot, ["branch", "-D", branch], exec);
    });
}
