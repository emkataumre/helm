// src/main/engine/worktree.ts
import { join } from "node:path";
import { writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
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
// Single source of truth shared by createWorktree (-B, create-or-reset) and the M6 rebuild executor
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

// The on-disk twin of `-B`: a prior partial cleanup can leave debris at the target path — usually an
// unregistered junk dir (a node_modules `git worktree remove` couldn't fully delete), rarely a still-
// registered worktree. Either fails `git worktree add` with "already exists", which blocked a requeued
// task's merge stage. Clear both forms before adding. Best-effort on each step (`worktree add` itself
// is the loud postcondition); assumes the caller holds the repoLock.
async function preCleanWorktreePath(repoRoot: string, path: string, exec: ExecFn): Promise<void> {
    if (!existsSync(path)) return;
    await exec("git", ["-C", repoRoot, "worktree", "remove", "--force", path]); // the registered case
    forceRemoveDir(path);                                                       // the junk case (long-path rmrf)
    await exec("git", ["-C", repoRoot, "worktree", "prune"]);                   // reconcile the admin dir
}

export async function createWorktree(repoRoot: string, fromBranch: string, branch: string, worktreeDir: string, exec: ExecFn = run): Promise<string> {
    const path = worktreePathFor(repoRoot, worktreeDir, branch);
    await repoLock.withLock(repoRoot, async () => {
        // `-B` (create-or-reset), not `-b`: a stale throwaway branch left by a prior partial cleanup
        // (e.g. `helm/merge-<id>`) must not fail worktree creation with "branch already exists" — that
        // collision re-wedged a requeued task. For a fresh task branch the branch doesn't exist, so -B
        // behaves exactly like -b.
        await preCleanWorktreePath(repoRoot, path, exec);
        await git(repoRoot, ["worktree", "add", "-B", branch, path, fromBranch], exec);
        await installTrunkGuard(repoRoot, path, exec);
    });
    return path;
}

// ── M6-② Task 4: the worktree-scoped trunk-guard hook (the git-level suspenders under the classifier
// belt) ───────────────────────────────────────────────────────────────────────────────────────────
// A Helm-managed hooks dir holds a reject-all `pre-push`; each task/throwaway worktree points its
// `core.hooksPath` at it via WORKTREE-scoped config, so the agent (and a drop-in human inside a
// worktree) literally cannot push — even via an indirect script — while the primary checkout, which
// hosts the human's promotion push (slice ③, run from repoRoot after the throwaway is removed), stays
// free. Best-effort: a git too old for `extensions.worktreeConfig` degrades to belt-only (the Task-3
// permissions.deny already blocks the agent) rather than bricking worktree creation. Verified on
// Windows git by the Task-4 build-spike. Assumes the caller holds the repoLock (config writes to
// .git/config race otherwise).
const HELM_PRE_PUSH = "#!/bin/sh\necho 'Helm: agents never push - hand back to Helm to land/promote' 1>&2\nexit 1\n";

export async function installTrunkGuard(repoRoot: string, worktreePath: string, exec: ExecFn = run): Promise<void> {
    try {
        const hooksDir = join(repoRoot, ".helm", "hooks");
        mkdirSync(hooksDir, { recursive: true });
        const hookPath = join(hooksDir, "pre-push");
        if (!existsSync(hookPath)) writeFileSync(hookPath, HELM_PRE_PUSH, { mode: 0o755 }); // create once, idempotent
        // Repo-wide switch that makes --worktree config legal (harmless), then the worktree-local hooksPath.
        await git(repoRoot, ["config", "extensions.worktreeConfig", "true"], exec);
        await git(worktreePath, ["config", "--worktree", "core.hooksPath", hooksDir], exec);
    } catch (e) {
        // Suspenders, not the belt: never fail worktree creation over the hook. The permissions.deny
        // belt (Task 3) still blocks the agent; log the degradation so it's visible.
        console.log(`[helm] trunk-guard hook not installed for ${worktreePath} (belt-only): ${e instanceof Error ? e.message : String(e)}`);
    }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Long-path-aware, best-effort recursive delete. Windows deep node_modules paths exceed MAX_PATH (260);
// the \\?\ prefix opts into the Win32 long-path API so rmSync can delete them. NEVER throws — a leftover
// directory is cosmetic, and cleanup must never wedge the caller.
export function forceRemoveDir(dir: string): void {
    try {
        const target = process.platform === "win32" && !dir.startsWith("\\\\?\\")
            ? "\\\\?\\" + dir.replace(/\//g, "\\")
            : dir;
        rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch { /* best-effort — a leftover throwaway dir never blocks the loop */ }
}

// Remove a worktree and (optionally) its branch. RESILIENT by contract: `git worktree remove` fails on
// Windows when a deep node_modules path exceeds MAX_PATH ("Filename too long") or a lock is transiently
// held, so retry, then fall back to pruning the registration + a long-path-aware rmrf. Best-effort and
// MUST NOT throw: a failed removal here previously propagated up and wedged the task loop in "running"
// (the merge had already advanced integration, but the throwaway cleanup threw in mergeStage's finally).
export async function removeWorktree(
    repoRoot: string, worktreePath: string, branch: string, keepBranch: boolean,
    exec: ExecFn = run, rmDir: (dir: string) => void = forceRemoveDir,
): Promise<void> {
    await repoLock.withLock(repoRoot, async () => {
        let removed = false;
        for (let attempt = 0; attempt < 3 && !removed; attempt++) {
            const r = await exec("git", ["-C", repoRoot, "worktree", "remove", "--force", worktreePath]);
            removed = r.code === 0;
            if (!removed && attempt < 2) await delay(200);
        }
        if (!removed) {
            await exec("git", ["-C", repoRoot, "worktree", "prune"]); // drop the registration git couldn't
            rmDir(worktreePath);                                      // force-delete the on-disk dir (long-path)
            await exec("git", ["-C", repoRoot, "worktree", "prune"]); // reconcile the admin dir post-delete
        }
        if (!keepBranch) await exec("git", ["-C", repoRoot, "branch", "-D", branch]); // best-effort
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
    await repoLock.withLock(repoRoot, async () => {
        // A half-reaped worktree (dir survives, registration gone) is precisely the rebuild scenario —
        // pre-clean the debris or the add fails "already exists" (same hazard as createWorktree).
        await preCleanWorktreePath(repoRoot, path, exec);
        await git(repoRoot, ["worktree", "add", path, branch], exec);
        await installTrunkGuard(repoRoot, path, exec); // the rebuilt worktree gets the same guard as a fresh one
    });
}
