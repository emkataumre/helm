// tests/engine/worktree.test.ts
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type ExecFn, type ExecResult } from "../../src/main/engine/exec";
import { ensureBranch, checkoutBranch, createWorktree, removeWorktree, listWorktrees, listBranches, addWorktreeForBranch, worktreePathFor, installTrunkGuard } from "../../src/main/engine/worktree";

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });

it("M6: worktreePathFor maps a branch to <repoDir>/<worktreeDir>/<sanitized-branch>", () => {
    expect(worktreePathFor("/repo", ".helm/worktrees", "ralph/task-1")).toBe(join("/repo", ".helm/worktrees", "ralph-task-1"));
});

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

// M6 ①: the git-state read primitives the boot reconcile executor needs. listWorktrees parses the
// porcelain blocks — a `detached` worktree (no branch) must yield branch = null, not a spurious name.
it("M6: listWorktrees parses `worktree list --porcelain` blocks, mapping detached → null branch", async () => {
    const porcelain = [
        "worktree /repo",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/integration/ralph",
        "",
        "worktree /repo/.helm/worktrees/ralph-task-1",
        "HEAD 2222222222222222222222222222222222222222",
        "branch refs/heads/ralph/task-1",
        "",
        "worktree /repo/.helm/worktrees/helm-merge-x",
        "HEAD 3333333333333333333333333333333333333333",
        "detached",
        "",
    ].join("\n");
    const fake: ExecFn = async () => ok(porcelain);
    expect(await listWorktrees("/repo", fake)).toEqual([
        { path: "/repo", branch: "integration/ralph" },
        { path: "/repo/.helm/worktrees/ralph-task-1", branch: "ralph/task-1" },
        { path: "/repo/.helm/worktrees/helm-merge-x", branch: null },
    ]);
});

// M6 ①: the primitives against REAL git — listBranches/listWorktrees observe true state, and
// addWorktreeForBranch (the rebuild path) recreates a worktree on an EXISTING branch without `-b`.
it("M6: lists real branches + worktrees, then rebuilds a worktree on an existing branch (no -b)", async () => {
    const repo = await tempRepo();
    try {
        await ensureBranch(repo, "integration/ralph", "main");
        const wt = await createWorktree(repo, "integration/ralph", "ralph/task-1", ".helm/worktrees");

        const branches = await listBranches(repo);
        expect(branches).toEqual(expect.arrayContaining(["main", "integration/ralph", "ralph/task-1"]));

        const listed = await listWorktrees(repo);
        expect(listed.some((w) => w.branch === "ralph/task-1")).toBe(true);
        expect(listed.some((w) => w.branch === "main")).toBe(true); // the primary checkout (on main) is included

        // Simulate the crash: worktree gone, branch RETAINED (keepBranch: true).
        await removeWorktree(repo, wt, "ralph/task-1", true);
        expect(existsSync(wt)).toBe(false);
        expect(await listBranches(repo)).toContain("ralph/task-1"); // branch survived → rebuild is possible

        // The rebuild primitive: recreate the worktree from the surviving branch tip (no -b).
        await addWorktreeForBranch(repo, wt, "ralph/task-1");
        expect(existsSync(wt)).toBe(true);
        expect((await listWorktrees(repo)).some((w) => w.branch === "ralph/task-1")).toBe(true);

        await removeWorktree(repo, wt, "ralph/task-1", false);
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});

// ── M6-② Task 4: worktree-scoped trunk-guard hook ────────────────────────────────────────────────
// installTrunkGuard writes a reject-all pre-push into a Helm-managed hooks dir and points the
// worktree's hooks there via worktree-scoped config (extensions.worktreeConfig + --worktree
// core.hooksPath). Unit-level: real temp dir for the fs, fake exec records the git config argv.
it("M6: installTrunkGuard writes a reject-all pre-push and issues the worktree-scoped hooksPath config", async () => {
    const repo = mkdtempSync(join(tmpdir(), "helm-guard-"));
    try {
        const wt = join(repo, ".helm", "worktrees", "ralph-task-1");
        const calls: string[][] = [];
        const fake: ExecFn = async (_cmd, args) => { calls.push(args ?? []); return ok(""); };

        await installTrunkGuard(repo, wt, fake);

        // The hook exists, rejects (exit 1), and carries the hand-back message.
        const hookPath = join(repo, ".helm", "hooks", "pre-push");
        expect(existsSync(hookPath)).toBe(true);
        const hook = readFileSync(hookPath, "utf8");
        expect(hook).toMatch(/exit 1/);
        expect(hook).toMatch(/never push/i);

        // extensions.worktreeConfig enabled repo-wide, then the worktree-scoped hooksPath set.
        const flat = calls.map((c) => c.join(" "));
        expect(flat.some((c) => c.includes(`-C ${repo}`) && c.includes("extensions.worktreeConfig") && c.includes("true"))).toBe(true);
        expect(flat.some((c) => c.includes(`-C ${wt}`) && c.includes("--worktree") && c.includes("core.hooksPath"))).toBe(true);
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});

// The load-bearing REAL-git proof (mirrors the build-spike): a worktree created via createWorktree
// gets a guard that ACTUALLY rejects a push from inside the worktree, while the main checkout — which
// hosts the human's promotion push (slice ③) — is NOT hook-blocked.
it("M6: a task worktree's push is rejected by the hook; the main checkout's push is not", async () => {
    const base = mkdtempSync(join(tmpdir(), "helm-guardE2E-"));
    const remote = join(base, "remote.git");
    const repo = join(base, "main");
    try {
        await run("git", ["-C", base, "init", "--bare", "remote.git"]);
        await run("git", ["init", "-b", "master", repo]);
        await run("git", ["-C", repo, "config", "user.email", "t@t.t"]);
        await run("git", ["-C", repo, "config", "user.name", "t"]);
        await run("git", ["-C", repo, "remote", "add", "origin", remote]);
        await run("git", ["-C", repo, "commit", "--allow-empty", "-m", "c1"]);
        await run("git", ["-C", repo, "push", "origin", "master"]);
        await ensureBranch(repo, "integration/ralph", "master");

        // createWorktree installs the guard as part of creation.
        const wt = await createWorktree(repo, "integration/ralph", "ralph/task-1", ".helm/worktrees");
        await run("git", ["-C", wt, "commit", "--allow-empty", "-m", "c2"]);

        // Push FROM the worktree → rejected (non-zero, the hook message on stderr).
        const wtPush = await run("git", ["-C", wt, "push", "origin", "ralph/task-1"]);
        expect(wtPush.code).not.toBe(0);
        expect(wtPush.stderr).toMatch(/never push/i);

        // Push from the MAIN checkout → NOT hook-blocked (the promotion-push path stays free).
        await run("git", ["-C", repo, "commit", "--allow-empty", "-m", "c3"]);
        const mainPush = await run("git", ["-C", repo, "push", "origin", "master"]);
        expect(mainPush.code).toBe(0);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// M4 PROBE: parallel first-run. Three tasks boot at once and all call ensureBranch on the
// not-yet-existing integration branch, then each `git worktree add` — repo-level git mutations that
// race (fatal: branch 'integration/ralph' already exists; index.lock contention). They must be
// serialized per repo so every task gets its worktree, not just the one that won the race.
it("M4: concurrent ensureBranch + createWorktree on a fresh repo don't race", async () => {
    const repo = await tempRepo();
    try {
        await Promise.all([0, 1, 2].map(() => ensureBranch(repo, "integration/ralph", "main")));
        const wts = await Promise.all([1, 2, 3].map((n) =>
            createWorktree(repo, "integration/ralph", `ralph/task-${n}`, ".helm/worktrees")));
        for (const wt of wts) expect(existsSync(wt)).toBe(true);
        await Promise.all(wts.map((wt, i) => removeWorktree(repo, wt, `ralph/task-${i + 1}`, false)));
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
