// ─────────────────────────────────────────────────────────────────────────────────────────────────
// M8.5 acceptance harness — drives the REAL built Helm app via playwright-core's _electron driver.
//
// OPERATIONAL CONSTRAINTS (read before running `npm run accept`):
//   • CLOSE ANY RUNNING HELM FIRST. `npm run accept` swaps better_sqlite3.node to the ELECTRON ABI and
//     rebuilds it; a live Helm holds the .node open (EBUSY on the swap). This is the standing gotcha —
//     ask the human to close Helm, never force-kill it.
//   • Accept LEAVES the ABI on Electron. The next `npm run check` runs its `pretest` (abi:node) and swaps
//     back — the existing dance, unchanged. So: run `npm run accept`, then `npm run check` restores node.
//   • The app under test ALWAYS runs against a throwaway HELM_USER_DATA (mkdtemp). The real board
//     (%APPDATA%\helm\helm.db) is unreachable BY CONSTRUCTION — the board-seed lesson, institutionalized.
//   • SURFACES: `window.helm` (the preload IPC bridge, present in the production build) is the
//     machine-readable agent handle. data-verify-* attributes DO NOT EXIST in the production build
//     (verifyAttrs strips them for zero prod footprint), so scenarios assert via window.helm + visible
//     DOM text — never data-verify. (Task-1 spike finding.)
//   • A launch failure is a LOUD FAIL (launchHelm throws), never a silent skip — BLOCKED is not a pass.
//   • Every scenario try/finally-closes its app, so a failed assertion never leaks an Electron process.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import type { TaskStatus } from "../../src/shared/types";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BASE_SCHEMA_SQL, retainedWorktreePath, seedProjectSql, seedTaskSql } from "./seed";

const repoRoot = join(import.meta.dirname, "..", "..");
const ARTIFACTS = join(repoRoot, "tests", "accept", "artifacts"); // recorded .webm evidence (gitignored)

function git(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

// A fresh throwaway dir under the OS temp — auto-cleaned by the OS; nothing lands near the repo.
export function tmp(prefix: string): string {
    return mkdtempSync(join(tmpdir(), `helm-accept-${prefix}-`));
}

// The C:\Temp\helm-target recipe AS CODE: a real git repo on `main` whose `check` is always green, plus a
// verify:content-style gate and a verify:fail (the target-repo recipe). Real-git-in-tmpdir precedent:
// worktree.test.ts. The scripts are `node -e` one-liners → `check` needs no `npm install`. Also creates the
// integration branch the engine expects.
export function makeTargetRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "accept@helm.test"]);
    git(dir, ["config", "user.name", "Helm Accept"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    const pkg = {
        name: "helm-accept-target", version: "0.0.0", private: true,
        scripts: {
            check: 'node -e "process.exit(0)"',           // always green (Layer-A)
            "verify:content": 'node -e "process.exit(0)"', // a content-style gate
            "verify:fail": 'node -e "process.exit(1)"',    // deliberately red (silent)
            // M11 pre-flight: a legit gate that's RED before any work AND prints — an ok-red with an evidence tail.
            "verify:red": "node -e \"console.error('preflight red: gate not yet satisfied'); process.exit(1)\"",
        },
    };
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    writeFileSync(join(dir, "README.md"), "# helm accept target\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "chore: accept target repo"]);
    git(dir, ["branch", "integration/ralph"]);
}

// Create a REAL retained worktree for a task branch (mirrors createWorktree: `worktree add -b <branch>
// <path> main`). Boot-reconcile then sees it as owned by a retaining (needs-human) task and never prunes it.
// Returns the exact on-disk path (== the path to seed as task.worktreePath).
export function addRetainedWorktree(repoDir: string, branch: string): string {
    const path = retainedWorktreePath(repoDir, branch);
    git(repoDir, ["worktree", "add", "-b", branch, path, "main"]);
    return path;
}

// Give a target repo a REAL bare `origin` remote with main + integration/ralph pushed. Promote fetches
// origin/<targetBranch>, so without an origin the promote path throws at the fetch; with it (and integration
// == main) it reaches the clean `nothing-to-promote` outcome — exercising the whole M6-③ promote path over
// real git while pushing NOTHING to the target. Returns the bare origin dir. Forward-slashed remote URL so
// git can't misread a Windows backslash path.
export function makeOrigin(repoDir: string): string {
    const origin = tmp("origin");
    git(origin, ["init", "--bare", "-b", "main"]);
    git(repoDir, ["remote", "add", "origin", origin.replace(/\\/g, "/")]);
    git(repoDir, ["push", "origin", "main", "integration/ralph"]);
    return origin;
}

// Seed helm.db via the sqlite3 CLI (piped over stdin) — ABI-independent: the vitest driver process sits on
// the Electron ABI and cannot load better-sqlite3, so the CLI is the only way in. Prepends the base schema;
// the app's real migrate() carries it to head on boot. A bad statement makes sqlite3 exit non-zero →
// execFileSync throws → a LOUD failure (never a silent mis-seed).
export function seedDb(userDataDir: string, statements: string[]): void {
    const sql = [BASE_SCHEMA_SQL, ...statements, ""].join("\n");
    execFileSync("sqlite3", [join(userDataDir, "helm.db")], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

// ── Fixture builders (shared across scenarios) ─────────────────────────────────────────────────────

// A project only (a real target repo) — enough to render the `+ <name>` free-terminal button.
export function seededProject(name = "AcceptProj"): { repo: string; projectId: string; seed: string[] } {
    const repo = tmp("repo");
    makeTargetRepo(repo);
    const projectId = randomUUID();
    return { repo, projectId, seed: [seedProjectSql({ id: projectId, name, repoPath: repo })] };
}

// A project + one needs-human task owning a REAL retained worktree. Boot-reconcile leaves retained
// worktrees alone, so the fixture survives boot unchanged (title visible, worktree present).
export interface SeededBoard { repo: string; projectId: string; taskId: string; branch: string; worktreePath: string; title: string; seed: string[]; }
// A project + one task in a RETAINING state (needs-human by default, or handed-off) that OWNS a real
// retained worktree. Boot-reconcile leaves retaining worktrees alone, so the fixture survives boot
// unchanged (title visible, worktree present). status must be a retaining state — the scheduler never
// auto-starts needs-human/handed-off, so no fixture here ever spawns a real claude.
export function seededNeedsHumanBoard(name = "AcceptProj", title = "Seeded needs-human task", status: TaskStatus = "needs-human"): SeededBoard {
    const repo = tmp("repo");
    makeTargetRepo(repo);
    const projectId = randomUUID();
    const taskId = randomUUID();
    const branch = `ralph/task-${taskId}`;
    const worktreePath = addRetainedWorktree(repo, branch);
    const seed = [
        seedProjectSql({ id: projectId, name, repoPath: repo }),
        seedTaskSql({ id: taskId, projectId, title, status, branchName: branch, worktreePath, createdAt: Date.now() }),
    ];
    return { repo, projectId, taskId, branch, worktreePath, title, seed };
}

// A project + one MERGED task — terminal (the scheduler never starts it) and worktree-less (a merged task's
// worktree was reaped). Renders in the `merged` lane; opening it shows the M3 observability detail rebuilt
// from DB rows (empty feed, but every section renders). No worktree ⇒ boot-reconcile has nothing to prune.
export interface SeededMerged { repo: string; projectId: string; taskId: string; title: string; seed: string[]; }
export function seededMergedBoard(name = "AcceptProj", title = "Seeded merged task"): SeededMerged {
    const repo = tmp("repo");
    makeTargetRepo(repo);
    const projectId = randomUUID();
    const taskId = randomUUID();
    const seed = [
        seedProjectSql({ id: projectId, name, repoPath: repo }),
        seedTaskSql({ id: taskId, projectId, title, status: "merged", branchName: `ralph/task-${taskId}`, worktreePath: null, createdAt: Date.now() }),
    ];
    return { repo, projectId, taskId, title, seed };
}

// A project whose repo has a real bare origin (integration == main). Enough to click Promote and reach the
// clean `nothing-to-promote` outcome through the REAL promote path (fetch origin, count commits beyond the
// target) — proving the M6-③ Promote UI wiring end to end without pushing anything to the target.
export function seededPromotableProject(name = "PromoteProj"): { repo: string; origin: string; projectId: string; seed: string[] } {
    const repo = tmp("repo");
    makeTargetRepo(repo);
    const origin = makeOrigin(repo);
    const projectId = randomUUID();
    return { repo, origin, projectId, seed: [seedProjectSql({ id: projectId, name, repoPath: repo })] };
}

export interface LaunchedHelm {
    app: ElectronApplication;
    page: Page;
    userData: string;
    close: () => Promise<void>;
}

// Launch a hermetic, optionally-seeded Helm and wait until the cockpit is interactive. `seed` = SQL
// statements (use seedProjectSql/seedTaskSql). recordVideo lands a .webm under tests/accept/artifacts/.
export async function launchHelm(opts: { seed?: string[] } = {}): Promise<LaunchedHelm> {
    const userData = tmp("ud");
    mkdirSync(ARTIFACTS, { recursive: true });
    if (opts.seed?.length) seedDb(userData, opts.seed);

    // A launch failure throws here — loud FAIL, never a skip. Budget generously: Electron boot + the
    // per-project boot reconcile (real git) can take a few seconds.
    const app = await electron.launch({
        args: ["."],
        cwd: repoRoot,
        env: { ...process.env, HELM_USER_DATA: userData },
        recordVideo: { dir: ARTIFACTS },
        timeout: 120_000,
    });
    const page = await app.firstWindow({ timeout: 60_000 });
    // React mounted + the board rendered (the h1 is the most stable anchor).
    await page.getByRole("heading", { name: "Helm", level: 1 }).waitFor({ state: "visible", timeout: 60_000 });
    const helmType = await page.evaluate(() => typeof window.helm);
    if (helmType !== "object") throw new Error(`window.helm not exposed (got ${helmType}) — preload bridge missing`);

    // Just close the app — do NOT explicitly ptyKill sessions here. app.close() force-terminates Electron
    // and its job object reaps the child pwsh (verified leak-free), so there's nothing to dispose. Keeping
    // scenario-initiated kills to the minimum each scenario actually asserts (close-tab / abandon) is good
    // hygiene, not a correctness fix — the machine-wide "terminal randomly dies" gun was node-pty's
    // OS-conpty kill firing a delayed process.kill() at a recycled PID; it's fixed at the source in
    // nodePtyFactory.ts (useConptyDll: true → no agent fork, no 5s fallback). See kill.accept.ts.
    const close = async () => { try { await app.close(); } catch { /* best-effort teardown */ } };
    return { app, page, userData, close };
}

// ── PTY assertion helpers over window.helm (the structured agent handle; no xterm DOM scraping) ─────
export const normPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();
export const ptyList = (page: Page) => page.evaluate(() => window.helm.ptyList());
// Subscribe (once) to pty:data for a session and (re)attach so main streams it — the replay-then-live
// buffer lands in a page-global keyed by id. Re-attaching after a reset captures exactly the scrollback
// replay (how a tab-switch remount re-paints history).
export async function collect(page: Page, sid: string): Promise<void> {
    await page.evaluate((id) => {
        const w = window as unknown as { __bufs?: Record<string, string>; __subs?: Record<string, () => void> };
        w.__bufs ??= {}; w.__subs ??= {};
        w.__bufs[id] = "";
        w.__subs[id] ??= window.helm.onPtyData((eid, chunk) => { const b = w.__bufs!; if (b[eid] != null) b[eid] += chunk; });
        return window.helm.ptyAttach(id);
    }, sid);
}
export const readBuf = (page: Page, sid: string) =>
    page.evaluate((id) => (window as unknown as { __bufs?: Record<string, string> }).__bufs?.[id] ?? "", sid);

// Poll `fn` until it returns truthy or the timeout elapses; returns the (non-nullable) truthy value, or
// throws a labelled error on timeout (a loud FAIL, never a hang that reads as a skip). Used for the async
// settling the real app does (PTY boot, reap, etc.).
export async function until<T>(fn: () => Promise<T> | T, opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {}): Promise<NonNullable<T>> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const intervalMs = opts.intervalMs ?? 200;
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    for (;;) {
        try { const v = await fn(); if (v) return v as NonNullable<T>; last = v; }
        catch (e) { last = e; }
        if (Date.now() > deadline) throw new Error(`until(${opts.label ?? "condition"}) timed out after ${timeoutMs}ms; last=${JSON.stringify(last)}`);
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}
