# Helm Milestone 1 — End-to-End Single-Pass Spine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the greenfield Electron+TS app and run a single task end-to-end — register a project, create a task, watch the engine make a worktree, run one Claude pass, commit, run the check, and squash-merge a green result into the integration branch — visible in a minimal cockpit.

**Architecture:** Electron main process hosts the engine (DB + git + Claude spawning); React renderer is a thin cockpit talking to it over typed IPC. Engine modules are pure, dependency-injected functions (ported from Pail's tested design) so they unit-test without Electron. This milestone is the **tracer bullet** — the thinnest real path through DB ↔ git ↔ Claude ↔ merge — that later milestones thicken into the Ralph loop, parallelism, drop-in, and promotion.

**Tech Stack:** TypeScript (ESM), Electron + electron-vite, React, better-sqlite3, Vitest, Node ≥ 20. Package manager: npm.

**Plan set:** This is **Milestone 1 of 6**. Later milestones are separate plans, written as we reach them (each informed by building the prior):
- M2 — true Ralph loop (`/goal` inner + engine-authoritative gate, iterations, progress files, termination, acceptance gate)
- M3 — `stream-json` observability + the real task-centric cockpit
- M4 — parallel scheduler + serialized merge (mutex, rebase-on-tip, re-check)
- M5 — drop-in handoff
- M6 — promotion (`pr`/`direct`/`strict`) + safety hardening (auto-mode env injection, `permissions.deny`/trunk-guard, tray-resident, crash-resume)

**Spec:** `docs/specs/2026-06-28-phase-1-executor-spine-design.md`

**M1 scope notes / deferrals (deliberate):**
- Single pass, **not** a loop (M2). One `claude -p` invocation per task.
- **No `/goal`, no `stream-json`** yet — plain `claude -p … --permission-mode auto`, output captured on completion (like Pail's `agent.ts`). `/goal` lands in M2, `stream-json`/session-id capture in M3.
- The acceptance field is **stored** but **not run** in M1 — the Layer-B acceptance gate arrives in M2. M1 gates on the project check only.
- Normal window (close = quit). Tray-resident + crash-resume land in M6.
- Single task at a time, run on demand via a button. The scheduler/parallelism is M4.

---

## File Structure

```
I:\Personal\helm\
  package.json
  tsconfig.json
  tsconfig.node.json
  electron.vite.config.ts
  vitest.config.ts
  .gitignore
  index.html                      # renderer entry
  src/
    shared/
      types.ts                    # Project, Task, Iteration, IpcApi contract — single source of truth
    main/
      index.ts                    # app lifecycle, window, IPC registration
      ipc.ts                      # maps IpcApi channels → engine/db calls
      db/
        db.ts                     # better-sqlite3 open + schema
        projects.ts               # project row CRUD
        tasks.ts                  # task row CRUD + status updates
        iterations.ts             # iteration row CRUD
      engine/
        exec.ts                   # child_process wrapper (port from Pail)
        check.ts                  # run project check command (port from Pail)
        worktree.ts               # git worktree create/remove/branch (port from Pail)
        merge.ts                  # commitAll, squashMergeInto, diffStat (port + adapt from Pail)
        spawn.ts                  # THE single Claude-spawn chokepoint
        runTask.ts                # single-pass orchestrator (DI) — becomes the Ralph loop in M2
    preload/
      index.ts                    # contextBridge → window.helm
    renderer/
      main.tsx                    # React mount
      App.tsx                     # project form + new-task form + task list + log
  tests/                          # Vitest specs mirror src/ paths
```

**Responsibility boundaries:** `engine/*` knows nothing about Electron, the DB, or the renderer — pure functions over injected `exec`. `db/*` knows nothing about git or Claude. `ipc.ts` is the only glue that wires engine + db to channels. `runTask.ts` orchestrates via an injected `Deps` object (Pail's pattern), so the whole flow tests with zero real git/Claude.

---

## Task 1: Scaffold the Electron + TS + Vitest project

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.node.json`, `electron.vite.config.ts`, `vitest.config.ts`, `.gitignore`, `index.html`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/main.tsx`, `src/renderer/App.tsx`

- [x] **Step 1: Create `package.json`** (better-sqlite3 bumped ^11→^12 for Node 24 ABI; see commit body)

```json
{
  "name": "helm",
  "version": "0.0.1",
  "description": "Cockpit for autonomous Ralph-loop coding agents",
  "main": "out/main/index.js",
  "type": "module",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "check": "npm run typecheck && npm run test"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^20.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "electron": "^31.0.0",
    "electron-vite": "^2.3.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "typescript": "^5.5.0",
    "vite": "^5.3.0",
    "vitest": "^2.0.0"
  }
}
```

- [x] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "tests"]
}
```

- [x] **Step 3: Create `tsconfig.node.json`** (electron-vite expects it)

```json
{ "extends": "./tsconfig.json", "include": ["electron.vite.config.ts"] }
```

- [x] **Step 4: Create `electron.vite.config.ts`**

```ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    main: { plugins: [externalizeDepsPlugin()] },
    preload: { plugins: [externalizeDepsPlugin()] },
    renderer: { plugins: [react()] },
});
```

- [x] **Step 5: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/**/*.test.ts"],
    },
});
```

- [x] **Step 6: Create `.gitignore`**

```
node_modules/
out/
dist/
*.log
.helm/
helm.db
```

- [x] **Step 7: Create `index.html`**

```html
<!doctype html>
<html>
  <head><meta charset="UTF-8" /><title>Helm</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/renderer/main.tsx"></script>
  </body>
</html>
```

- [x] **Step 8: Create placeholder `src/main/index.ts`**

```ts
import { app, BrowserWindow } from "electron";
import { join } from "node:path";

function createWindow(): void {
    const win = new BrowserWindow({
        width: 1100,
        height: 760,
        webPreferences: { preload: join(import.meta.dirname, "../preload/index.js") },
    });
    if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
    else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
```

- [x] **Step 9: Create placeholder `src/preload/index.ts`**

```ts
import { contextBridge } from "electron";
contextBridge.exposeInMainWorld("helm", {});
```

- [x] **Step 10: Create `src/renderer/main.tsx` and `src/renderer/App.tsx`**

```tsx
// src/renderer/main.tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(<App />);
```

```tsx
// src/renderer/App.tsx
export function App() {
    return <h1>Helm</h1>;
}
```

- [x] **Step 11: Install and verify it boots** — `npm install` done (better-sqlite3 12.11.1 loads under Node ABI 137); `npm run dev` window-open visual check deferred to human

Run: `npm install`
Run: `npm run dev`
Expected: an Electron window opens showing "Helm". Close it.

- [x] **Step 12: Commit**

```bash
git init
git add -A
git commit -m "chore: scaffold electron + ts + vitest app"
```

---

## Task 2: Shared types (the single source of truth)

**Files:**
- Create: `src/shared/types.ts`

- [x] **Step 1: Write the types**

```ts
// src/shared/types.ts
export type TaskStatus = "queued" | "running" | "merged" | "needs-human" | "abandoned";

export interface Project {
    id: string;
    name: string;
    repoPath: string;
    integrationBranch: string; // default "integration/ralph"
    targetBranch: string;      // branch integration is created from AND promoted into
    branchPrefix: string;      // default "ralph" -> task branches "ralph/task-<id>"
    checkCommand: string;      // mandatory; the Layer-A gate
    worktreeDir: string;       // relative to repoPath; default ".helm/worktrees"
}

export interface Task {
    id: string;
    projectId: string;
    title: string;
    intent: string;            // prose directive (what to build)
    acceptance: string[];      // executable proof commands (stored now; run from M2)
    status: TaskStatus;
    branchName: string | null;
    worktreePath: string | null;
    diffstat: string | null;
    failureReason: string | null;
    createdAt: number;
    updatedAt: number;
}

export interface Iteration {
    id: string;
    taskId: string;
    index: number;
    sessionId: string | null;  // captured from M3 (stream-json)
    startedAt: number;
    endedAt: number | null;
    gateVerdict: "green" | "failed" | "hang" | null;
    commitSha: string | null;
    outputTail: string | null;
}

// IPC contract: the renderer calls these; main implements them.
export interface NewProjectInput {
    name: string;
    repoPath: string;
    targetBranch: string;
    checkCommand: string;
}
export interface NewTaskInput {
    projectId: string;
    title: string;
    intent: string;
    acceptance: string[];
}
export interface HelmApi {
    registerProject: (input: NewProjectInput) => Promise<Project>;
    listProjects: () => Promise<Project[]>;
    createTask: (input: NewTaskInput) => Promise<Task>;
    listTasks: () => Promise<Task[]>;
    runTask: (taskId: string) => Promise<TaskStatus>;
    onTasksChanged: (cb: () => void) => void;
}
```

- [x] **Step 2: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: shared domain + IPC types"
```

---

## Task 3: Port `exec.ts` from Pail

**Files:**
- Create: `src/main/engine/exec.ts`, `tests/engine/exec.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/engine/exec.test.ts
import { run } from "../../src/main/engine/exec";

it("captures stdout and a zero exit code", async () => {
    const r = await run(process.execPath, ["-e", "process.stdout.write('hi')"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hi");
    expect(r.timedOut).toBe(false);
});

it("reports a non-zero exit code", async () => {
    const r = await run(process.execPath, ["-e", "process.exit(3)"]);
    expect(r.code).toBe(3);
});

it("times out and flags timedOut", async () => {
    const r = await run(process.execPath, ["-e", "setTimeout(()=>{}, 5000)"], { timeoutMs: 150 });
    expect(r.timedOut).toBe(true);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/exec.test.ts`
Expected: FAIL — cannot find module `exec`.

- [x] **Step 3: Write the implementation** (ported from Pail `src/exec.ts`; `ExecResult` inlined)

```ts
// src/main/engine/exec.ts
import { spawn } from "node:child_process";

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean; }
export interface ExecOptions { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; shell?: boolean; }
export type ExecFn = (command: string, args?: string[], opts?: ExecOptions) => Promise<ExecResult>;

export const run: ExecFn = (command, args = [], opts = {}) =>
    new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            shell: opts.shell ?? false,
            windowsHide: true,
        });
        let stdout = "", stderr = "", timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        child.stdout?.on("data", (d) => (stdout += d.toString()));
        child.stderr?.on("data", (d) => (stderr += d.toString()));
        if (opts.timeoutMs && opts.timeoutMs > 0) {
            timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, opts.timeoutMs);
        }
        child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr, timedOut }); });
        child.on("error", (err) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut }); });
    });

function killTree(pid?: number): void {
    if (!pid) return;
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/exec.test.ts`
Expected: PASS (3 tests).

- [x] **Step 5: Commit**

```bash
git add src/main/engine/exec.ts tests/engine/exec.test.ts
git commit -m "feat(engine): port exec wrapper from Pail"
```

---

## Task 4: Port `check.ts` from Pail

**Files:**
- Create: `src/main/engine/check.ts`, `tests/engine/check.test.ts`

- [x] **Step 1: Write the failing test** (inject a fake exec)

```ts
// tests/engine/check.test.ts
import { runCheck } from "../../src/main/engine/check";
import type { ExecFn } from "../../src/main/engine/exec";

const fakeExec = (result: { code: number; timedOut?: boolean }): ExecFn =>
    async () => ({ code: result.code, stdout: "out", stderr: "err", timedOut: result.timedOut ?? false });

it("is green on exit 0", async () => {
    const r = await runCheck("/wt", "npm test", 1000, fakeExec({ code: 0 }));
    expect(r.green).toBe(true);
    expect(r.timedOut).toBe(false);
});

it("is not green on non-zero exit", async () => {
    const r = await runCheck("/wt", "npm test", 1000, fakeExec({ code: 1 }));
    expect(r.green).toBe(false);
});

it("flags a timeout as not green", async () => {
    const r = await runCheck("/wt", "npm test", 1000, fakeExec({ code: -1, timedOut: true }));
    expect(r.green).toBe(false);
    expect(r.timedOut).toBe(true);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/check.test.ts`
Expected: FAIL — cannot find module `check`.

- [x] **Step 3: Write the implementation** (ported from Pail `src/check.ts`; `checkCommand`/`timeoutMs` passed directly instead of via a Config object)

```ts
// src/main/engine/check.ts
import { run, type ExecFn } from "./exec";

export async function runCheck(
    worktreePath: string,
    checkCommand: string,
    timeoutMs: number,
    exec: ExecFn = run,
): Promise<{ green: boolean; timedOut: boolean; output: string }> {
    const res = await exec(checkCommand, [], { cwd: worktreePath, timeoutMs, shell: true });
    return {
        green: res.code === 0 && !res.timedOut,
        timedOut: res.timedOut,
        output: `${res.stdout}\n${res.stderr}`.trim(),
    };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/check.test.ts`
Expected: PASS (3 tests).

- [x] **Step 5: Commit**

```bash
git add src/main/engine/check.ts tests/engine/check.test.ts
git commit -m "feat(engine): port check runner from Pail"
```

---

## Task 5: Port `worktree.ts` from Pail (M1 subset)

**Files:**
- Create: `src/main/engine/worktree.ts`, `tests/engine/worktree.test.ts`

Note: M1 needs `ensureBranch`, `checkoutBranch`, `createWorktree`, `removeWorktree`. `pruneOrphans`/`runSetup` are deferred to M6/M2.

- [x] **Step 1: Write the failing test** (real git in a temp repo)

```ts
// tests/engine/worktree.test.ts
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/main/engine/exec";
import { ensureBranch, checkoutBranch, createWorktree, removeWorktree } from "../../src/main/engine/worktree";

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
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/worktree.test.ts`
Expected: FAIL — cannot find module `worktree`.

- [x] **Step 3: Write the implementation** (ported from Pail `src/worktree.ts`; `worktreeDir` is now a parameter instead of the hardcoded `.pail`)

```ts
// src/main/engine/worktree.ts
import { join } from "node:path";
import { run, type ExecFn } from "./exec";

function sanitize(branch: string): string {
    return branch.replace(/[^a-zA-Z0-9._-]/g, "-");
}

async function git(repoRoot: string, args: string[], exec: ExecFn): Promise<string> {
    const r = await exec("git", ["-C", repoRoot, ...args]);
    if (r.code !== 0) throw new Error(`Helm: git ${args.join(" ")} failed: ${r.stderr.trim()}`);
    return r.stdout;
}

export async function ensureBranch(repoRoot: string, name: string, createFrom: string, exec: ExecFn = run): Promise<void> {
    const check = await exec("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", name]);
    if (check.code === 0) return;
    await git(repoRoot, ["branch", name, createFrom], exec);
}

export async function checkoutBranch(repoRoot: string, name: string, exec: ExecFn = run): Promise<void> {
    await git(repoRoot, ["checkout", name], exec);
}

export async function createWorktree(repoRoot: string, fromBranch: string, branch: string, worktreeDir: string, exec: ExecFn = run): Promise<string> {
    const path = join(repoRoot, worktreeDir, sanitize(branch));
    await git(repoRoot, ["worktree", "add", "-b", branch, path, fromBranch], exec);
    return path;
}

export async function removeWorktree(repoRoot: string, worktreePath: string, branch: string, keepBranch: boolean, exec: ExecFn = run): Promise<void> {
    await git(repoRoot, ["worktree", "remove", "--force", worktreePath], exec);
    if (!keepBranch) await git(repoRoot, ["branch", "-D", branch], exec);
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/worktree.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/main/engine/worktree.ts tests/engine/worktree.test.ts
git commit -m "feat(engine): port worktree management from Pail (M1 subset)"
```

---

## Task 6: `merge.ts` — commitAll, squashMergeInto, diffStat

**Files:**
- Create: `src/main/engine/merge.ts`, `tests/engine/merge.test.ts`

Note: Helm **squash-merges** task branches (clean one-commit-per-task), where Pail uses `--no-ff`. `commitAll` and `diffStat` port directly.

- [x] **Step 1: Write the failing test** (real git temp repo)

```ts
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
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/merge.test.ts`
Expected: FAIL — cannot find module `merge`.

- [x] **Step 3: Write the implementation**

```ts
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
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/merge.test.ts`
Expected: PASS (2 tests).

- [x] **Step 5: Commit**

```bash
git add src/main/engine/merge.ts tests/engine/merge.test.ts
git commit -m "feat(engine): commitAll, squash-merge, diffStat"
```

---

## Task 7: `spawn.ts` — the single Claude-spawn chokepoint

**Files:**
- Create: `src/main/engine/spawn.ts`, `tests/engine/spawn.test.ts`

This is the **one** place Claude is launched (so M6's Docker jail is a one-line change here). M1 runs `claude -p <intent> --permission-mode auto`, captures output on completion. `/goal`, `stream-json`, and session-id capture are added here in M2/M3.

- [x] **Step 1: Write the failing test** (assert command shape via injected exec)

```ts
// tests/engine/spawn.test.ts
import { spawnAgent } from "../../src/main/engine/spawn";
import type { ExecFn, ExecResult } from "../../src/main/engine/exec";

it("invokes claude with -p, auto permission mode, in the worktree, and reports success", async () => {
    let seen: { command: string; args: string[]; cwd?: string } | null = null;
    const fakeExec: ExecFn = async (command, args = [], opts = {}) => {
        seen = { command, args, cwd: opts.cwd };
        return { code: 0, stdout: "done", stderr: "", timedOut: false } as ExecResult;
    };
    const r = await spawnAgent("/wt", "build the thing", { model: "claude-opus-4-8" }, fakeExec);
    expect(r.ok).toBe(true);
    expect(seen!.command).toBe("claude");
    expect(seen!.cwd).toBe("/wt");
    expect(seen!.args).toEqual(["-p", "build the thing", "--permission-mode", "auto", "--model", "claude-opus-4-8"]);
});

it("reports failure on non-zero exit", async () => {
    const fakeExec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false });
    const r = await spawnAgent("/wt", "x", {}, fakeExec);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("boom");
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/spawn.test.ts`
Expected: FAIL — cannot find module `spawn`.

- [x] **Step 3: Write the implementation**

```ts
// src/main/engine/spawn.ts
import { run, type ExecFn } from "./exec";

export interface SpawnOptions { model?: string; extraArgs?: string[]; timeoutMs?: number; }
export interface SpawnResult { ok: boolean; output: string; sessionId: string | null; }

// THE single chokepoint for launching Claude. M6 swaps the `claude` invocation for
// `docker run … claude` here and nowhere else.
export async function spawnAgent(
    worktreePath: string,
    prompt: string,
    opts: SpawnOptions = {},
    exec: ExecFn = run,
): Promise<SpawnResult> {
    const args = [
        "-p", prompt,
        "--permission-mode", "auto",
        ...(opts.model ? ["--model", opts.model] : []),
        ...(opts.extraArgs ?? []),
    ];
    const res = await exec("claude", args, { cwd: worktreePath, timeoutMs: opts.timeoutMs });
    return { ok: res.code === 0 && !res.timedOut, output: `${res.stdout}\n${res.stderr}`.trim(), sessionId: null };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/spawn.test.ts`
Expected: PASS (2 tests).

- [x] **Step 5: Commit**

```bash
git add src/main/engine/spawn.ts tests/engine/spawn.test.ts
git commit -m "feat(engine): single claude-spawn chokepoint (auto mode)"
```

---

## Task 8: `db.ts` — SQLite open + schema

**Files:**
- Create: `src/main/db/db.ts`, `tests/db/db.test.ts`

- [x] **Step 1: Write the failing test** (in-memory DB)

```ts
// tests/db/db.test.ts
import { openDb } from "../../src/main/db/db";

it("creates projects, tasks, iterations tables", () => {
    const db = openDb(":memory:");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["projects", "tasks", "iterations"]));
    db.close();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/db.test.ts`
Expected: FAIL — cannot find module `db`.

- [x] **Step 3: Write the implementation**

```ts
// src/main/db/db.ts
import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDb(path: string): Db {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, repoPath TEXT NOT NULL,
            integrationBranch TEXT NOT NULL, targetBranch TEXT NOT NULL,
            branchPrefix TEXT NOT NULL, checkCommand TEXT NOT NULL, worktreeDir TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
            intent TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL,
            branchName TEXT, worktreePath TEXT, diffstat TEXT, failureReason TEXT,
            createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS iterations (
            id TEXT PRIMARY KEY, taskId TEXT NOT NULL, idx INTEGER NOT NULL,
            sessionId TEXT, startedAt INTEGER NOT NULL, endedAt INTEGER,
            gateVerdict TEXT, commitSha TEXT, outputTail TEXT
        );
    `);
    return db;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/db.test.ts`
Expected: PASS.

Note: if `better-sqlite3` fails to load under Vitest with an ABI error, run `npm rebuild better-sqlite3` (it is a native module). For the Electron runtime, electron-vite externalizes it via `externalizeDepsPlugin`.

- [x] **Step 5: Commit**

```bash
git add src/main/db/db.ts tests/db/db.test.ts
git commit -m "feat(db): sqlite schema for projects/tasks/iterations"
```

---

## Task 9: `projects.ts` — project CRUD

**Files:**
- Create: `src/main/db/projects.ts`, `tests/db/projects.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/db/projects.test.ts
import { openDb } from "../../src/main/db/db";
import { insertProject, listProjects, getProject } from "../../src/main/db/projects";

it("inserts a project with defaults and lists it back", () => {
    const db = openDb(":memory:");
    const p = insertProject(db, { name: "Helm", repoPath: "C:/r", targetBranch: "main", checkCommand: "npm run check" });
    expect(p.id).toBeTruthy();
    expect(p.integrationBranch).toBe("integration/ralph");
    expect(p.branchPrefix).toBe("ralph");
    expect(p.worktreeDir).toBe(".helm/worktrees");
    expect(listProjects(db)).toHaveLength(1);
    expect(getProject(db, p.id)?.name).toBe("Helm");
    db.close();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/projects.test.ts`
Expected: FAIL — cannot find module `projects`.

- [x] **Step 3: Write the implementation**

```ts
// src/main/db/projects.ts
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import type { Project, NewProjectInput } from "../../shared/types";

export function insertProject(db: Db, input: NewProjectInput): Project {
    const p: Project = {
        id: randomUUID(),
        name: input.name,
        repoPath: input.repoPath,
        integrationBranch: "integration/ralph",
        targetBranch: input.targetBranch,
        branchPrefix: "ralph",
        checkCommand: input.checkCommand,
        worktreeDir: ".helm/worktrees",
    };
    db.prepare(
        `INSERT INTO projects (id,name,repoPath,integrationBranch,targetBranch,branchPrefix,checkCommand,worktreeDir)
         VALUES (@id,@name,@repoPath,@integrationBranch,@targetBranch,@branchPrefix,@checkCommand,@worktreeDir)`,
    ).run(p);
    return p;
}

export function listProjects(db: Db): Project[] {
    return db.prepare("SELECT * FROM projects ORDER BY name").all() as Project[];
}

export function getProject(db: Db, id: string): Project | undefined {
    return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/projects.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/main/db/projects.ts tests/db/projects.test.ts
git commit -m "feat(db): project CRUD with sensible defaults"
```

---

## Task 10: `tasks.ts` — task CRUD + status updates

**Files:**
- Create: `src/main/db/tasks.ts`, `tests/db/tasks.test.ts`

`acceptance` is a `string[]` in the domain but stored as JSON text; serialize on write, parse on read.

- [x] **Step 1: Write the failing test**

```ts
// tests/db/tasks.test.ts
import { openDb } from "../../src/main/db/db";
import { insertTask, getTask, listTasks, updateTask } from "../../src/main/db/tasks";

it("inserts a queued task, round-trips acceptance, updates status", () => {
    const db = openDb(":memory:");
    const t = insertTask(db, { projectId: "p1", title: "T", intent: "do it", acceptance: ["npm test -- x"] });
    expect(t.status).toBe("queued");
    expect(getTask(db, t.id)?.acceptance).toEqual(["npm test -- x"]);
    updateTask(db, t.id, { status: "merged", diffstat: "+3 -1" });
    const got = getTask(db, t.id)!;
    expect(got.status).toBe("merged");
    expect(got.diffstat).toBe("+3 -1");
    expect(listTasks(db)).toHaveLength(1);
    db.close();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/tasks.test.ts`
Expected: FAIL — cannot find module `tasks`.

- [x] **Step 3: Write the implementation**

```ts
// src/main/db/tasks.ts
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import type { Task, NewTaskInput } from "../../shared/types";

interface Row extends Omit<Task, "acceptance"> { acceptance: string; }

function toTask(row: Row): Task {
    return { ...row, acceptance: JSON.parse(row.acceptance) as string[] };
}

export function insertTask(db: Db, input: NewTaskInput): Task {
    const now = Date.now();
    const t: Task = {
        id: randomUUID(),
        projectId: input.projectId,
        title: input.title,
        intent: input.intent,
        acceptance: input.acceptance,
        status: "queued",
        branchName: null, worktreePath: null, diffstat: null, failureReason: null,
        createdAt: now, updatedAt: now,
    };
    db.prepare(
        `INSERT INTO tasks (id,projectId,title,intent,acceptance,status,branchName,worktreePath,diffstat,failureReason,createdAt,updatedAt)
         VALUES (@id,@projectId,@title,@intent,@acceptance,@status,@branchName,@worktreePath,@diffstat,@failureReason,@createdAt,@updatedAt)`,
    ).run({ ...t, acceptance: JSON.stringify(t.acceptance) });
    return t;
}

export function getTask(db: Db, id: string): Task | undefined {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? toTask(row) : undefined;
}

export function listTasks(db: Db): Task[] {
    return (db.prepare("SELECT * FROM tasks ORDER BY createdAt DESC").all() as Row[]).map(toTask);
}

export function updateTask(db: Db, id: string, patch: Partial<Pick<Task, "status" | "branchName" | "worktreePath" | "diffstat" | "failureReason">>): void {
    const fields = Object.keys(patch);
    if (fields.length === 0) return;
    const set = fields.map((f) => `${f} = @${f}`).join(", ");
    db.prepare(`UPDATE tasks SET ${set}, updatedAt = @updatedAt WHERE id = @id`).run({ ...patch, id, updatedAt: Date.now() });
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/tasks.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/main/db/tasks.ts tests/db/tasks.test.ts
git commit -m "feat(db): task CRUD + status updates"
```

---

## Task 11: `iterations.ts` — iteration CRUD

**Files:**
- Create: `src/main/db/iterations.ts`, `tests/db/iterations.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/db/iterations.test.ts
import { openDb } from "../../src/main/db/db";
import { addIteration, finishIteration, listIterations } from "../../src/main/db/iterations";

it("adds an iteration and finalizes its verdict", () => {
    const db = openDb(":memory:");
    const it = addIteration(db, "task1", 0);
    expect(it.gateVerdict).toBeNull();
    finishIteration(db, it.id, { gateVerdict: "green", outputTail: "ok" });
    const got = listIterations(db, "task1")[0];
    expect(got.gateVerdict).toBe("green");
    expect(got.endedAt).not.toBeNull();
    db.close();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/iterations.test.ts`
Expected: FAIL — cannot find module `iterations`.

- [x] **Step 3: Write the implementation** (note the DB column is `idx`, mapped to `index` in the domain type)

```ts
// src/main/db/iterations.ts
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import type { Iteration } from "../../shared/types";

interface Row { id: string; taskId: string; idx: number; sessionId: string | null; startedAt: number; endedAt: number | null; gateVerdict: Iteration["gateVerdict"]; commitSha: string | null; outputTail: string | null; }
const toIteration = (r: Row): Iteration => ({ id: r.id, taskId: r.taskId, index: r.idx, sessionId: r.sessionId, startedAt: r.startedAt, endedAt: r.endedAt, gateVerdict: r.gateVerdict, commitSha: r.commitSha, outputTail: r.outputTail });

export function addIteration(db: Db, taskId: string, index: number): Iteration {
    const it: Iteration = { id: randomUUID(), taskId, index, sessionId: null, startedAt: Date.now(), endedAt: null, gateVerdict: null, commitSha: null, outputTail: null };
    db.prepare(`INSERT INTO iterations (id,taskId,idx,sessionId,startedAt,endedAt,gateVerdict,commitSha,outputTail)
                VALUES (@id,@taskId,@idx,@sessionId,@startedAt,@endedAt,@gateVerdict,@commitSha,@outputTail)`)
        .run({ ...it, idx: index });
    return it;
}

export function finishIteration(db: Db, id: string, patch: Partial<Pick<Iteration, "gateVerdict" | "commitSha" | "outputTail" | "sessionId">>): void {
    const fields = Object.keys(patch);
    const set = [...fields.map((f) => `${f} = @${f}`), "endedAt = @endedAt"].join(", ");
    db.prepare(`UPDATE iterations SET ${set} WHERE id = @id`).run({ ...patch, id, endedAt: Date.now() });
}

export function listIterations(db: Db, taskId: string): Iteration[] {
    return (db.prepare("SELECT * FROM iterations WHERE taskId = ? ORDER BY idx").all(taskId) as Row[]).map(toIteration);
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/iterations.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/main/db/iterations.ts tests/db/iterations.test.ts
git commit -m "feat(db): iteration CRUD"
```

---

## Task 12: `runTask.ts` — the single-pass orchestrator (M1 heart)

**Files:**
- Create: `src/main/engine/runTask.ts`, `tests/engine/runTask.test.ts`

This mirrors Pail's `runLoop` body for one task, fully dependency-injected so the whole flow tests without real git/Claude. In M2 this file grows the iteration loop; in M1 it does one pass.

- [x] **Step 1: Write the failing test** (all deps faked; assert the happy path and the check-fail path)

```ts
// tests/engine/runTask.test.ts
import { runTaskSinglePass, type RunTaskDeps } from "../../src/main/engine/runTask";
import type { Project, Task } from "../../src/shared/types";

const project: Project = {
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph",
    targetBranch: "main", branchPrefix: "ralph", checkCommand: "npm test", worktreeDir: ".helm/worktrees",
};
const task: Task = {
    id: "abc", projectId: "p1", title: "T", intent: "do", acceptance: ["x"], status: "queued",
    branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0,
};

function deps(overrides: Partial<RunTaskDeps> = {}): { deps: RunTaskDeps; calls: string[] } {
    const calls: string[] = [];
    const base: RunTaskDeps = {
        ensureBranch: async () => { calls.push("ensureBranch"); },
        checkoutBranch: async () => { calls.push("checkoutBranch"); },
        createWorktree: async () => { calls.push("createWorktree"); return "/repo/.helm/worktrees/ralph-task-abc"; },
        removeWorktree: async (_r, _p, _b, keep) => { calls.push(`removeWorktree:${keep}`); },
        spawnAgent: async () => { calls.push("spawn"); return { ok: true, output: "ok", sessionId: null }; },
        commitAll: async () => { calls.push("commitAll"); },
        runCheck: async () => { calls.push("runCheck"); return { green: true, timedOut: false, output: "" }; },
        squashMergeInto: async () => { calls.push("merge"); return { merged: true, conflict: false }; },
        diffStat: async () => "+1 -0",
        setStatus: (_id, s, _extra) => { calls.push(`status:${s}`); },
        addIteration: () => ({ id: "it1" }),
        finishIteration: () => { calls.push("finishIteration"); },
        log: () => {},
        ...overrides,
    };
    return { deps: base, calls };
}

it("happy path: spawn → commit → check green → squash-merge → merged + worktree removed", async () => {
    const { deps: d, calls } = deps();
    const status = await runTaskSinglePass(project, task, d);
    expect(status).toBe("merged");
    expect(calls).toEqual([
        "ensureBranch", "checkoutBranch", "createWorktree", "status:running",
        "spawn", "commitAll", "runCheck", "merge", "status:merged", "finishIteration", "removeWorktree:false",
    ]);
});

it("check fails → needs-human, worktree kept for inspection", async () => {
    const { deps: d, calls } = deps({ runCheck: async () => ({ green: false, timedOut: false, output: "boom" }) });
    const status = await runTaskSinglePass(project, task, d);
    expect(status).toBe("needs-human");
    expect(calls).toContain("status:needs-human");
    expect(calls).toContain("removeWorktree:true");
    expect(calls).not.toContain("merge");
});

it("agent failure → needs-human before the check runs", async () => {
    const { deps: d, calls } = deps({ spawnAgent: async () => ({ ok: false, output: "claude died", sessionId: null }) });
    const status = await runTaskSinglePass(project, task, d);
    expect(status).toBe("needs-human");
    expect(calls).not.toContain("runCheck");
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/runTask.test.ts`
Expected: FAIL — cannot find module `runTask`.

- [x] **Step 3: Write the implementation**

```ts
// src/main/engine/runTask.ts
import type { Project, Task, TaskStatus } from "../../shared/types";

export interface RunTaskDeps {
    ensureBranch: (repo: string, name: string, from: string) => Promise<void>;
    checkoutBranch: (repo: string, name: string) => Promise<void>;
    createWorktree: (repo: string, from: string, branch: string, worktreeDir: string) => Promise<string>;
    removeWorktree: (repo: string, path: string, branch: string, keepBranch: boolean) => Promise<void>;
    spawnAgent: (worktreePath: string, prompt: string, opts: { model?: string }) => Promise<{ ok: boolean; output: string; sessionId: string | null }>;
    commitAll: (repo: string, message: string) => Promise<void>;
    runCheck: (worktreePath: string, checkCommand: string, timeoutMs: number) => Promise<{ green: boolean; timedOut: boolean; output: string }>;
    squashMergeInto: (repo: string, taskBranch: string, target: string) => Promise<{ merged: boolean; conflict: boolean }>;
    diffStat: (repo: string, base: string, branch: string) => Promise<string>;
    setStatus: (taskId: string, status: TaskStatus, extra?: { branchName?: string; worktreePath?: string; diffstat?: string; failureReason?: string }) => void;
    addIteration: (taskId: string, index: number) => { id: string };
    finishIteration: (id: string, patch: { gateVerdict: "green" | "failed" | "hang"; outputTail: string }) => void;
    log: (msg: string) => void;
}

const CHECK_TIMEOUT_MS = 30 * 60 * 1000; // generous; the loop's real bounds arrive in M2

export async function runTaskSinglePass(project: Project, task: Task, d: RunTaskDeps): Promise<TaskStatus> {
    await d.ensureBranch(project.repoPath, project.integrationBranch, project.targetBranch);
    await d.checkoutBranch(project.repoPath, project.integrationBranch);

    const branch = `${project.branchPrefix}/task-${task.id}`;
    const path = await d.createWorktree(project.repoPath, project.integrationBranch, branch, project.worktreeDir);
    d.setStatus(task.id, "running", { branchName: branch, worktreePath: path });

    const iter = d.addIteration(task.id, 0);

    const fail = async (reason: string, verdict: "failed" | "hang", output: string): Promise<TaskStatus> => {
        d.finishIteration(iter.id, { gateVerdict: verdict, outputTail: output.slice(-1500) });
        d.setStatus(task.id, "needs-human", { failureReason: reason });
        await d.removeWorktree(project.repoPath, path, branch, true); // keep branch for inspection
        d.log(`task ${task.id} needs-human: ${reason}`);
        return "needs-human";
    };

    const agent = await d.spawnAgent(path, task.intent, {});
    await d.commitAll(path, `ralph: task ${task.id} ${task.title}`);
    if (!agent.ok) return fail("agent did not complete", "failed", agent.output);

    const check = await d.runCheck(path, project.checkCommand, CHECK_TIMEOUT_MS);
    if (!check.green) return fail(check.timedOut ? "check timed out (hang)" : "check failed", check.timedOut ? "hang" : "failed", check.output);

    const diffstat = await d.diffStat(project.repoPath, project.integrationBranch, branch);
    const merge = await d.squashMergeInto(project.repoPath, branch, project.integrationBranch);
    if (merge.conflict) return fail("merge conflict", "failed", "squash-merge conflicted");

    d.setStatus(task.id, "merged", { diffstat });
    d.finishIteration(iter.id, { gateVerdict: "green", outputTail: agent.output.slice(-1500) });
    await d.removeWorktree(project.repoPath, path, branch, false);
    d.log(`task ${task.id} merged (${diffstat})`);
    return "merged";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/runTask.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/engine/runTask.ts tests/engine/runTask.test.ts
git commit -m "feat(engine): single-pass task orchestrator (DI)"
```

---

## Task 13: Wire the IPC layer (main)

**Files:**
- Create: `src/main/ipc.ts`
- Modify: `src/main/index.ts`, `src/preload/index.ts`

This is the only glue between engine + db and the renderer. It builds the real `RunTaskDeps` from the engine/db modules.

- [ ] **Step 1: Write `src/main/ipc.ts`**

```ts
// src/main/ipc.ts
import { ipcMain, type BrowserWindow } from "electron";
import { app } from "electron";
import { join } from "node:path";
import { openDb } from "./db/db";
import { insertProject, listProjects, getProject } from "./db/projects";
import { insertTask, listTasks, getTask, updateTask } from "./db/tasks";
import { addIteration, finishIteration } from "./db/iterations";
import { ensureBranch, checkoutBranch, createWorktree, removeWorktree } from "./engine/worktree";
import { commitAll, squashMergeInto, diffStat } from "./engine/merge";
import { runCheck } from "./engine/check";
import { spawnAgent } from "./engine/spawn";
import { runTaskSinglePass, type RunTaskDeps } from "./engine/runTask";
import type { NewProjectInput, NewTaskInput, TaskStatus } from "../shared/types";

export function registerIpc(getWindow: () => BrowserWindow | null): void {
    const db = openDb(join(app.getPath("userData"), "helm.db"));
    const notify = () => getWindow()?.webContents.send("tasks:changed");

    ipcMain.handle("projects:register", (_e, input: NewProjectInput) => insertProject(db, input));
    ipcMain.handle("projects:list", () => listProjects(db));
    ipcMain.handle("tasks:create", (_e, input: NewTaskInput) => { const t = insertTask(db, input); notify(); return t; });
    ipcMain.handle("tasks:list", () => listTasks(db));

    ipcMain.handle("tasks:run", async (_e, taskId: string): Promise<TaskStatus> => {
        const task = getTask(db, taskId);
        if (!task) throw new Error(`unknown task ${taskId}`);
        const project = getProject(db, task.projectId);
        if (!project) throw new Error(`unknown project ${task.projectId}`);

        const deps: RunTaskDeps = {
            ensureBranch, checkoutBranch, createWorktree, removeWorktree,
            spawnAgent: (wt, prompt, opts) => spawnAgent(wt, prompt, opts),
            commitAll,
            runCheck: (wt, cmd, t) => runCheck(wt, cmd, t),
            squashMergeInto, diffStat,
            setStatus: (id, status, extra) => { updateTask(db, id, { status, ...extra }); notify(); },
            addIteration: (tid, idx) => addIteration(db, tid, idx),
            finishIteration: (id, patch) => finishIteration(db, id, patch),
            log: (m) => console.log(`[helm] ${m}`),
        };
        const status = await runTaskSinglePass(project, task, deps);
        notify();
        return status;
    });
}
```

- [ ] **Step 2: Update `src/main/index.ts` to register IPC and keep a window handle**

```ts
import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { registerIpc } from "./ipc";

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 760,
        webPreferences: { preload: join(import.meta.dirname, "../preload/index.js") },
    });
    if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    else mainWindow.loadFile(join(import.meta.dirname, "../renderer/index.html"));
    mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => {
    registerIpc(() => mainWindow);
    createWindow();
});
app.on("window-all-closed", () => app.quit());
```

- [ ] **Step 3: Update `src/preload/index.ts` to expose the typed API**

```ts
import { contextBridge, ipcRenderer } from "electron";
import type { HelmApi } from "../shared/types";

const api: HelmApi = {
    registerProject: (input) => ipcRenderer.invoke("projects:register", input),
    listProjects: () => ipcRenderer.invoke("projects:list"),
    createTask: (input) => ipcRenderer.invoke("tasks:create", input),
    listTasks: () => ipcRenderer.invoke("tasks:list"),
    runTask: (taskId) => ipcRenderer.invoke("tasks:run", taskId),
    onTasksChanged: (cb) => { ipcRenderer.on("tasks:changed", () => cb()); },
};
contextBridge.exposeInMainWorld("helm", api);
```

- [ ] **Step 4: Add the renderer global type**

Create `src/renderer/helm.d.ts`:

```ts
import type { HelmApi } from "../shared/types";
declare global { interface Window { helm: HelmApi; } }
export {};
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc.ts src/main/index.ts src/preload/index.ts src/renderer/helm.d.ts
git commit -m "feat(main): wire IPC for projects/tasks/run"
```

---

## Task 14: Minimal renderer (register project, new task, list, run)

**Files:**
- Modify: `src/renderer/App.tsx`

Lighter on TDD (UI wiring); verified manually in Task 15. Keep it crude — M3 builds the real board.

- [ ] **Step 1: Write `src/renderer/App.tsx`**

```tsx
import { useEffect, useState } from "react";
import type { Project, Task } from "../shared/types";

export function App() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    const refresh = async () => { setProjects(await window.helm.listProjects()); setTasks(await window.helm.listTasks()); };
    useEffect(() => { refresh(); window.helm.onTasksChanged(refresh); }, []);

    return (
        <div style={{ fontFamily: "system-ui", padding: 20, display: "grid", gap: 24, maxWidth: 900, margin: "0 auto" }}>
            <h1>Helm</h1>
            <ProjectForm onDone={refresh} />
            <TaskForm projects={projects} onDone={refresh} />
            <section>
                <h2>Tasks</h2>
                {tasks.map((t) => (
                    <div key={t.id} style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, marginBottom: 8 }}>
                        <b>{t.title}</b> — <code>{t.status}</code> {t.diffstat ? `(${t.diffstat})` : ""}
                        {t.failureReason ? <div style={{ color: "#b00" }}>{t.failureReason}</div> : null}
                        {t.status === "queued" ? <button onClick={() => window.helm.runTask(t.id)}>Run</button> : null}
                    </div>
                ))}
            </section>
        </div>
    );
}

function ProjectForm({ onDone }: { onDone: () => void }) {
    const [f, setF] = useState({ name: "", repoPath: "", targetBranch: "main", checkCommand: "" });
    return (
        <section>
            <h2>Register project</h2>
            {(["name", "repoPath", "targetBranch", "checkCommand"] as const).map((k) => (
                <input key={k} placeholder={k} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} style={{ display: "block", margin: "4px 0", width: 480 }} />
            ))}
            <button onClick={async () => { await window.helm.registerProject(f); onDone(); }}>Register</button>
        </section>
    );
}

function TaskForm({ projects, onDone }: { projects: Project[]; onDone: () => void }) {
    const [f, setF] = useState({ projectId: "", title: "", intent: "", acceptance: "" });
    return (
        <section>
            <h2>New task</h2>
            <select value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}>
                <option value="">— project —</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input placeholder="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} style={{ display: "block", margin: "4px 0", width: 480 }} />
            <textarea placeholder="intent (what to build)" value={f.intent} onChange={(e) => setF({ ...f, intent: e.target.value })} style={{ display: "block", margin: "4px 0", width: 480, height: 60 }} />
            <textarea placeholder="acceptance commands, one per line" value={f.acceptance} onChange={(e) => setF({ ...f, acceptance: e.target.value })} style={{ display: "block", margin: "4px 0", width: 480, height: 60 }} />
            <button
                disabled={!f.projectId || !f.title || !f.intent || !f.acceptance.trim()}
                onClick={async () => {
                    await window.helm.createTask({
                        projectId: f.projectId, title: f.title, intent: f.intent,
                        acceptance: f.acceptance.split("\n").map((s) => s.trim()).filter(Boolean),
                    });
                    onDone();
                }}
            >Create</button>
        </section>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat(renderer): minimal project + task + run UI"
```

---

## Task 15: End-to-end smoke test + full check

**Files:** none (manual verification)

- [ ] **Step 1: Create a throwaway target repo to drive** — _HUMAN smoke test (deferred per GUI boundary)_

```bash
mkdir C:\Temp\helm-target && cd C:\Temp\helm-target
git init -b main
echo node_modules/ > .gitignore
npm init -y
```
Edit its `package.json` to add a trivially-passing check: `"scripts": { "check": "node -e \"process.exit(0)\"" }`, then `git add -A && git commit -m init`.

- [ ] **Step 2: Run Helm** — _HUMAN smoke test (deferred per GUI boundary)_

Run: `npm run dev`
In the window: register a project (name `target`, repoPath `C:\Temp\helm-target`, targetBranch `main`, checkCommand `npm run check`). Create a task (title `smoke`, intent `Create a file hello.txt containing the word hello`, acceptance `node -e "require('fs').readFileSync('hello.txt')"`). Click **Run**.

- [ ] **Step 3: Verify the end-to-end result** — _HUMAN smoke test (deferred per GUI boundary)_

Expected: the task card flips `queued → running → merged` with a diffstat. Then in the target repo:
```bash
cd C:\Temp\helm-target
git log --oneline integration/ralph
```
Expected: an `integration/ralph` branch exists with a `ralph: merge ralph/task-<id>` commit containing `hello.txt`; the `.helm/worktrees/` directory is empty (worktree cleaned up).

- [ ] **Step 4: Verify a failing task goes to needs-human** — _HUMAN smoke test (deferred per GUI boundary)_

Create a second task whose intent is satisfiable but give it an impossible check by temporarily setting the project's check to `node -e "process.exit(1)"` (re-register as a new project, or hand-edit). Run it. Expected: card shows `needs-human` with reason "check failed", and the task branch is **retained** (`git branch --list "ralph/*"` shows it).

- [x] **Step 5: Run the full check and commit** — `npm run check` (typecheck clean, 18/18 Vitest pass) + `npm run build` green, run by Claude. Final commit message adapted to be honest (smoke test pending human), see commit body.

Run: `npm run check`
Expected: typecheck clean, all Vitest suites PASS.

```bash
git add -A
git commit -m "test: M1 end-to-end smoke verified"
```

---

## Self-Review

**Spec coverage (M1 scope only):**
- Electron + tray-resident engine (§4) → window + main-process engine done; **tray-resident + crash-resume deferred to M6** (noted).
- Project/Task/Iteration model + DB-authoritative state (§3, §15) → Tasks 2, 8–11. ✓
- Worktree-per-task, branch from integration, squash-merge, cleanup (§5.4, §12) → Tasks 5, 6, 12. ✓
- Independent check gate (§7, Layer A) → Tasks 4, 12. ✓ (**Layer-B acceptance deferred to M2** — field stored, Task 10.)
- Single agent-spawn chokepoint + auto mode (§4, §5.7) → Task 7. ✓ (**autoMode.environment injection + permissions.deny/trunk-guard deferred to M6**.)
- needs-human on failure, worktree retained (§14) → Task 12 fail path. ✓
- **Deliberately out of M1:** Ralph loop / `/goal` (M2), `stream-json`/session capture (M3), parallelism + merge mutex (M4), drop-in (M5), promotion + hardening (M6). All tracked in the plan-set list at the top.

**Placeholder scan:** none — every code step contains complete code; every run step has an exact command + expected result.

**Type consistency:** `RunTaskDeps` method names (`setStatus`, `addIteration`, `finishIteration`, `squashMergeInto`, `spawnAgent`, `runCheck`) match across Task 12's definition and Task 13's wiring; `updateTask` (db) is adapted into `setStatus` (deps) intentionally in `ipc.ts`. DB column `idx` ↔ domain `index` mapping is handled in `iterations.ts` (Task 11). `Project`/`Task`/`Iteration`/`HelmApi` shapes are defined once in Task 2 and consumed unchanged.
