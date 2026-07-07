// src/main/engine/exchange.ts
// M13 "git as the wall": the host-side git primitives that sync the host worktree with the per-task BARE
// EXCHANGE repo the jail container is bind-mounted (spec §2, spike FINDINGS §3). ExecFn-injected (merge.ts
// style) so the flow unit-tests with fakes. The exchange holds ONLY the task branch — never the real origin
// (invariant #1: origin-unreachable-in-jail). The engine is authoritative BEFORE each iteration (push in,
// force) and the container is authoritative AFTER (fetch out + hard-reset to what it pushed).
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { run, type ExecFn } from "./exec";

const git = (cwd: string, args: string[], exec: ExecFn) => exec("git", ["-C", cwd, ...args]);

// Create the bare exchange if absent (idempotent — a resume after a restart reuses it). Lives at a
// Helm-owned host path OUTSIDE the repo, so it never pollutes the target repo's git status, and is
// bind-mounted read+write into the container as /exchange.
export async function ensureExchange(exchangePath: string, exec: ExecFn = run): Promise<void> {
    if (existsSync(join(exchangePath, "HEAD"))) return; // already an initialised bare repo
    mkdirSync(dirname(exchangePath), { recursive: true });
    const r = await exec("git", ["init", "--bare", exchangePath]);
    if (r.code !== 0) throw new Error(`Helm: git init --bare ${exchangePath} failed: ${r.stderr.trim()}`);
}

// pushToExchange: the host worktree's HEAD → the exchange's task branch, FORCE (host is authoritative
// pre-iteration). `--no-verify` bypasses the worktree's M6-② trunk-guard pre-push hook: that hook exists
// to block the AGENT (now in the container, a separate clone with no hook) and the drop-in human — this is
// Helm's OWN trusted push to a LOCAL bare exchange, which is NOT the target/origin the never-push invariant
// protects (the exchange has no real remote and no credentials).
export async function pushToExchange(worktreePath: string, exchangePath: string, taskBranch: string, exec: ExecFn = run): Promise<void> {
    const r = await git(worktreePath, ["push", "--no-verify", "--force", exchangePath, `HEAD:refs/heads/${taskBranch}`], exec);
    if (r.code !== 0) throw new Error(`Helm: push to exchange (${taskBranch}) failed: ${r.stderr.trim()}`);
}

// fetchFromExchange: the exchange's task branch → the host worktree, then HARD-RESET the worktree to it —
// the container is authoritative post-iteration (its commit is the truth the host-side gate then judges).
// Gitignored deps (node_modules &c.) in the host worktree survive the reset, so the host gate keeps its
// host-native build (the whole point of "gates stay host-side").
export async function fetchFromExchange(worktreePath: string, exchangePath: string, taskBranch: string, exec: ExecFn = run): Promise<void> {
    const f = await git(worktreePath, ["fetch", exchangePath, `refs/heads/${taskBranch}`], exec);
    if (f.code !== 0) throw new Error(`Helm: fetch from exchange (${taskBranch}) failed: ${f.stderr.trim()}`);
    const r = await git(worktreePath, ["reset", "--hard", "FETCH_HEAD"], exec);
    if (r.code !== 0) throw new Error(`Helm: reset to exchange (${taskBranch}) failed: ${r.stderr.trim()}`);
}
