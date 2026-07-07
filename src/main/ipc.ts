// src/main/ipc.ts
import { ipcMain, Notification, type BrowserWindow } from "electron";
import { app } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { openDb } from "./db/db";
import { insertProject, listProjects, getProject, updateProject, deleteProject } from "./db/projects";
import { insertPlan, listPlans, getPlan } from "./db/plans";
import { insertTask, insertPlanTask, listTasks, getTask, updateTask, setDependsOn } from "./db/tasks";
import { addIteration, finishIteration, listIterations, latestSessionId } from "./db/iterations";
import { ensureBranch, checkoutBranch, createWorktree, removeWorktree, listWorktrees, listBranches, addWorktreeForBranch, worktreePathFor } from "./engine/worktree";
import { reconcile, isUnderWorktreeDir } from "./engine/reconcile";
import { buildInstructions, buildTaskDirective, seedProgress } from "./engine/prompt";
import { commitAll, squashMergeInto, diffStat, headSha, advanceBranch, fetchRemote, countCommitsBeyond, mergeNoFf, pushBranch, revParse } from "./engine/merge";
import { runMergeStage, type MergeStageDeps } from "./engine/mergeStage";
import { runPromoteStage, finalizePromotion, type PromoteStageDeps, type FinalizeDeps } from "./engine/promote";
import { runAcceptance } from "./engine/acceptance";
import { ensureRalphExcluded, ensureHelmExcluded, writeRalphFiles } from "./engine/ralph";
import { watchPlanDir, readPlanFiles, buildPlanRailState } from "./engine/planWatcher";
import { approveFromTasksJson, parsePlanDraft, staticPreflight, type PreflightCtx } from "./engine/planDraft";
import { runPreflight, unackedWarnCommands, type PreflightDeps } from "./engine/preflight";
import { runCheck } from "./engine/check";
import { run } from "./engine/exec";
import { spawnAgent } from "./engine/spawn";
import { buildSpawnSettings } from "./engine/spawnSettings";
import { createLogSink } from "./engine/logSink";
import { createSnapshotStore } from "./engine/snapshotStore";
import { snapshotFromRows } from "./engine/verifyState";
import { resolveLoopConfig, type LoopConfig } from "./engine/loopConfig";
import { detectProjectConfig } from "./engine/detect";
import { checkInsDue } from "./engine/checkIn";
import { createScheduler, type Scheduler } from "./engine/scheduler";
import { waitingOnFor } from "./engine/deps";
import { runTaskLoop, type RunTaskDeps, type ResumeContext } from "./engine/runTask";
import { launchTerminal, buildDropinArgv } from "./engine/terminalLaunch";
import { verifyAndMerge, abandon, type HandbackDeps } from "./engine/handback";
import { createPtyManager } from "./engine/ptyManager";
import { nodePtyFactory } from "./engine/nodePtyFactory";
import type { NewProjectInput, NewTaskInput, ProjectConfigPatch, Project, Task, TaskStatus, PromoteResponse, CreatePtyOptions, PtySession, PlanRailState, ApprovePlanResult, PreflightRunResult, ApproveOptions } from "../shared/types";

const CHECKIN_POLL_MS = 60_000; // re-evaluate the check-in cadence each minute

export function registerIpc(getWindow: () => BrowserWindow | null): { disposePtys: () => void } {
    const db = openDb(join(app.getPath("userData"), "helm.db"));
    const logsDir = join(app.getPath("userData"), "logs");
    const notify = () => getWindow()?.webContents.send("tasks:changed");
    // One live EngineSnapshot per active task; each dispatch nudges the renderer's detail view.
    const snapshots = createSnapshotStore((taskId) => getWindow()?.webContents.send("snapshot:changed", taskId));

    // M7 embedded terminal: ONE PtyManager for the whole app, with the real node-pty factory (the only
    // place node-pty is imported). SIBLING seam to spawn.ts — humans-only; agents keep the chokepoint.
    // A session's exit pushes pty:exit to the renderer; attach (below) pushes pty:data. Killed on Quit
    // (disposePtys, returned to index.ts) — a window-hide must NOT kill them (main-process residency).
    const ptyManager = createPtyManager(nodePtyFactory);
    ptyManager.onExit((id, code) => getWindow()?.webContents.send("pty:exit", id, code));

    // M10 plan ingestion: one live .helm/plan/ watcher per project (dispose fns), started lazily by
    // plans:openPlanner and torn down on Quit. The rail-state ctx reads package.json scripts + a fileExists
    // probe FRESH from the repo each fire (staticPreflight is a pure fn of that ctx).
    const planWatchers = new Map<string, () => void>();
    const planDirFor = (repoPath: string) => join(repoPath, ".helm", "plan");
    const planCtx = (repoPath: string): PreflightCtx => {
        let npmScripts: string[] = [];
        try { npmScripts = Object.keys((JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}); }
        catch { /* no package.json / unreadable → no scripts to match against */ }
        return { npmScripts, fileExists: (p) => existsSync(join(repoPath, p)) };
    };
    const readPlanRailState = (repoPath: string): PlanRailState => buildPlanRailState(readPlanFiles(planDirFor(repoPath)), planCtx(repoPath));
    // Empty the transient drop dir (keep the dir itself so the watcher's fs.watch handle stays valid).
    const clearPlanDir = (dir: string): void => {
        try { for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true }); }
        catch { /* dir gone / unreadable — nothing to clear */ }
    };

    // Forward-declared so startTask can close over the scheduler it itself is driven by (the merge
    // mutex lives on the scheduler, shared across a project's task loops).
    let scheduler: Scheduler;

    // Hoisted (M5) so both the loop's green branch and the verify-&-merge handback share one wiring.
    const runSetup = async (wt: string, cmd: string, t: number) => {
        const res = await run(cmd, [], { cwd: wt, timeoutMs: t, shell: true });
        return { ok: res.code === 0 && !res.timedOut, output: `${res.stdout}\n${res.stderr}`.trim() };
    };
    const buildMergeDeps = (taskId: string, config: LoopConfig): MergeStageDeps => ({
        createWorktree, squashMergeInto, runSetup,
        runCheck: (wt, cmd, to) => runCheck(wt, cmd, to),
        runAcceptance: (wt, cmds, to) => runAcceptance(wt, cmds, to),
        removeWorktree, diffStat, advanceBranch, headSha,
        checkTimeoutMs: config.checkTimeoutMs,
        emit: (e) => snapshots.dispatch(taskId, e),
    });
    // The handback deps (verify-&-merge / abandon). runMergeStage is mutex-wrapped per project (no
    // concurrency slot — drop-in freed it; only the merge mutex, so the cap + integration stay safe).
    // M8: the TASK-worktree removal (abandon + the verify-&-merge merged path both go through THIS
    // removeWorktree) first reaps any human shell cwd'd inside it — on Windows an open pwsh holds the
    // dir and would EBUSY the removal. Best-effort unlock only: removeWorktree keeps its tolerant/throwing
    // behavior unchanged. The engine-internal throwaway cleanups (buildMergeDeps/buildPromoteDeps) use the
    // RAW removeWorktree — no PTY can be cwd'd in a merge/promote throwaway, so they are deliberately untouched.
    const buildHandbackDeps = (config: LoopConfig): HandbackDeps => ({
        commitAll,
        runMergeStage: (p, t, b) => scheduler.mutexFor(p.id).withLock(() => runMergeStage(p, t, b, buildMergeDeps(t.id, config))),
        setStatus: (id, status, extra) => { updateTask(db, id, { status, ...extra }); notify(); },
        removeWorktree: async (repo, path, branch, keepBranch) => { ptyManager.killByCwdPrefix(path); await removeWorktree(repo, path, branch, keepBranch); },
    });

    // M6-③ batch-Promote deps: the same throwaway-worktree + setup + re-check engine fns as the merge
    // stage, plus the promotion primitives. finalizePromotionDeps injects the ONLY push (pushBranch) —
    // the verify slice inspects exactly this to prove the tool never pushes the target.
    const finalizePromotionDeps: FinalizeDeps = { pushBranch };
    const buildPromoteDeps = (config: LoopConfig): PromoteStageDeps => ({
        fetchRemote, countCommitsBeyond, revParse, createWorktree, mergeNoFf, runSetup,
        runCheck: (wt, cmd, t) => runCheck(wt, cmd, t),
        runAcceptance: (wt, cmds, t) => runAcceptance(wt, cmds, t),
        removeWorktree, headSha, diffStat,
        checkTimeoutMs: config.checkTimeoutMs,
    });

    // M11 pre-flight deps: a throwaway worktree off the integration tip, runSetup, one-shot command runner
    // (shell true, like acceptance), always-cleanup. NOTE the surface has NO advanceBranch/pushBranch — the
    // stage physically cannot advance a ref (the structural never-advance). Uses the RAW removeWorktree (no PTY
    // can be cwd'd in a pre-flight throwaway, exactly like the merge/promote throwaways).
    const buildPreflightDeps = (config: LoopConfig): PreflightDeps => ({
        ensureBranch, revParse, createWorktree, runSetup, removeWorktree,
        runCommand: async (wt, cmd, t) => {
            const r = await run(cmd, [], { cwd: wt, timeoutMs: t, shell: true });
            return { code: r.code, timedOut: r.timedOut, output: `${r.stdout}\n${r.stderr}`.trim() };
        },
        checkTimeoutMs: config.checkTimeoutMs,
    });

    // M5: per-task AbortController registry. tasks:dropIn aborts the controller (hard-killing the live
    // claude via killTree) then awaits `settled` — the loop's handed-off transition — before launching.
    const abortRegistry = new Map<string, { controller: AbortController; settled: Promise<TaskStatus> }>();

    // Run one task's Ralph loop to completion. The scheduler calls this fire-and-forget when a slot
    // is free; landing is delegated to the isolated merge stage, wrapped here in the project's merge
    // mutex (at most one merge in flight per project). The per-task check-in timer (M3) wraps each run.
    const startTask = async (task: Task): Promise<TaskStatus> => {
        const project = getProject(db, task.projectId);
        if (!project) throw new Error(`unknown project ${task.projectId}`);
        const config = resolveLoopConfig(project); // nullable project columns → concrete bounds

        // Register the drop-in interrupt handle. settled resolves with the loop's terminal status when
        // it returns, so a concurrent tasks:dropIn can abort → await the handed-off transition → launch.
        const controller = new AbortController();
        let resolveSettled!: (s: TaskStatus) => void;
        const settled = new Promise<TaskStatus>((res) => { resolveSettled = res; });
        abortRegistry.set(task.id, { controller, settled });

        // Resume discrimination (M5): a re-enqueued handed-off task kept its worktree, so worktreePath
        // is non-null → re-enter in resume mode (reuse the worktree, continue the DB index). A fresh
        // task was inserted with worktreePath = null → clone mode.
        const resume: ResumeContext | undefined = task.worktreePath != null && task.branchName != null
            ? { worktreePath: task.worktreePath, branch: task.branchName, startIndex: listIterations(db, task.id).length }
            : undefined;

        const deps: RunTaskDeps = {
            ensureBranch, checkoutBranch, createWorktree, removeWorktree,
            ensureRalphExcluded, writeRalphFiles,
            runSetup,
            // Inject the per-iteration raw-log sink (keyed by taskId + index) AND the per-spawn --settings
            // JSON (M6-② never-push belt + autoMode.environment) at the chokepoint. buildSpawnSettings runs
            // at this ipc edge so spawn.ts stays decoupled from Project (it just forwards the string).
            spawnAgent: (wt, prompt, opts) => spawnAgent(wt, prompt, { ...opts, logSink: createLogSink(logsDir, task.id, opts.iterationIndex ?? 0), settings: buildSpawnSettings(project) }),
            commitAll, headSha,
            runCheck: (wt, cmd, t) => runCheck(wt, cmd, t),
            runAcceptance: (wt, cmds, t) => runAcceptance(wt, cmds, t),
            squashMergeInto, diffStat,
            // Mutex-wrapped landing. Emit `merge: waiting` BEFORE acquiring the lock so a task queued
            // for the merge is visible in the feed, then serialize the real merge stage behind the
            // project's mutex (cross-project merges still run concurrently).
            mergeStage: (p, t, taskBranch) => {
                snapshots.dispatch(t.id, { type: "gate", index: 0, label: "merge: waiting" });
                return scheduler.mutexFor(p.id).withLock(() => runMergeStage(p, t, taskBranch, buildMergeDeps(t.id, config)));
            },
            setStatus: (id, status, extra) => { updateTask(db, id, { status, ...extra }); notify(); },
            addIteration: (tid, idx) => addIteration(db, tid, idx),
            // notify() after each finish: a completed iteration records a sessionId, flipping the task's
            // `resumable` true mid-run → the board re-fetches and enables Drop-in without a status change.
            finishIteration: (id, patch) => { finishIteration(db, id, patch); notify(); },
            emit: (e) => snapshots.dispatch(task.id, e),
            signal: controller.signal, // M5: a drop-in hard-kills the in-flight session
            log: (m) => console.log(`[helm] ${m}`),
        };

        const stopCheckIns = startCheckInTimer(task.id);
        let result: TaskStatus = "needs-human";
        try {
            result = await runTaskLoop(project, task, config, deps, resume);
            notify();
            return result;
        } finally {
            stopCheckIns();
            abortRegistry.delete(task.id);
            resolveSettled(result); // unblock any awaiting tasks:dropIn (the loop has settled)
        }
    };

    scheduler = createScheduler({
        listQueued: () => listTasks(db).filter((t) => t.status === "queued"),
        getProject: (id) => getProject(db, id),
        startTask,
        // M9 merged-gate: a queued child stays unstarted until every parent id reads "merged" (or is gone).
        getTaskStatus: (id) => getTask(db, id)?.status,
    });

    ipcMain.handle("projects:register", (_e, input: NewProjectInput) => insertProject(db, input));
    ipcMain.handle("projects:list", () => listProjects(db));
    // A raised cap may free conceptual slots → kick the scheduler after a config change.
    ipcMain.handle("projects:update", (_e, id: string, patch: ProjectConfigPatch) => { updateProject(db, id, patch); notify(); scheduler.kick(); return getProject(db, id) ?? null; });
    // Remove a project + all its tasks/iterations (deleteProject cascades atomically), then refresh the
    // board. An in-flight run of a deleted project keeps running in-memory but its DB writes simply no-op
    // (UPDATE ... WHERE id matches nothing) — the reconcile/scheduler already tolerate a vanished row.
    ipcMain.handle("projects:delete", (_e, id: string) => { deleteProject(db, id); notify(); });
    ipcMain.handle("projects:detect", (_e, repoPath: string) => detectProjectConfig(repoPath));
    // M6-③ project-level batch Promote. Mutex-serialized per project (don't promote while a task merge is
    // advancing integration). runPromoteStage validates on a FRESH origin/<target> tip and pushes NOTHING;
    // only on `ready` does finalizePromotion push a non-protected helper branch and return the copyable
    // commands that advance the target — the tool never pushes/merges the target itself.
    ipcMain.handle("projects:promote", (_e, projectId: string): Promise<PromoteResponse> => {
        const project = getProject(db, projectId);
        if (!project) throw new Error(`Helm: promote — unknown project ${projectId}`);
        const config = resolveLoopConfig(project);
        return scheduler.mutexFor(projectId).withLock(async () => {
            const r = await runPromoteStage(project, buildPromoteDeps(config));
            if (r.outcome !== "ready") return r;
            const f = await finalizePromotion(project, r, finalizePromotionDeps);
            return { ...r, ...f };
        });
    });
    // Create → enqueue → kick: the scheduler auto-starts it when a slot is free (unless paused).
    ipcMain.handle("tasks:create", (_e, input: NewTaskInput) => { const t = insertTask(db, input); notify(); scheduler.kick(); return t; });
    // Augment each task with `resumable` — does drop-in have a PERSISTED session to --resume? latestSessionId
    // is exactly what tasks:dropIn uses, so the button's enabled state matches what the click will actually do.
    // Plus the M9 derived merged-gate view: `blocked` + the `waitingOn` parents (waitingOnFor over the whole
    // board), so the cockpit can render "waiting on X" without the renderer knowing the gate rule.
    ipcMain.handle("tasks:list", () => {
        const tasks = listTasks(db);
        const byId = new Map(tasks.map((t) => [t.id, t]));
        return tasks.map((t) => {
            const waitingOn = waitingOnFor(t, (id) => byId.get(id));
            return { ...t, resumable: latestSessionId(listIterations(db, t.id)) != null, blocked: waitingOn.length > 0, waitingOn };
        });
    });
    // M9: replace a task's dependency edges — the cockpit's Clear-dependencies affordance on a stuck card
    // passes []. Clearing may unblock the task, so kick the scheduler after (honours pause).
    ipcMain.handle("tasks:setDependsOn", (_e, taskId: string, ids: string[]) => { setDependsOn(db, taskId, ids); notify(); scheduler.kick(); });

    // M4 scheduler IPC: paused-mode manual single-start, the live cockpit indicator state, pause toggle.
    ipcMain.handle("tasks:startNow", (_e, taskId: string) => { scheduler.startNow(taskId); });
    ipcMain.handle("scheduler:state", () => scheduler.state());
    ipcMain.handle("scheduler:setPaused", (_e, paused: boolean) => { scheduler.setPaused(paused); notify(); });

    // ── M5 drop-in handoff (spec §8), M7-retrofitted onto the in-app terminal ──────────────────────
    // Grab a running or needs-human task: hard-interrupt the live claude (freeing the slot), flip it to
    // handed-off (worktree retained), and open a terminal in the worktree resuming the latest session.
    // `fresh` = Start fresh (no --resume). Available from {running, needs-human} only. Returns the in-app
    // PtySession (so the renderer opens the drawer on it), or null for an external launch / any no-op.
    //
    // M7 semantics change: NULL terminalCommand → in-app PTY tab (the new default); non-NULL → external
    // launch via the existing (unchanged) template. The resume-guard + handed-off machine are UNTOUCHED.
    ipcMain.handle("tasks:dropIn", async (_e, taskId: string, fresh?: boolean): Promise<PtySession | null> => {
        const task = getTask(db, taskId);
        if (!task) return null;
        const project = getProject(db, task.projectId);
        if (!project) return null;

        if (task.status === "running") {
            // Abort the in-flight session and AWAIT the handed-off transition (bounded: taskkill + the
            // loop's !ok short-circuit). Capture reg BEFORE awaiting — startTask's finally deletes the
            // entry, but the captured `settled` promise still resolves.
            const reg = abortRegistry.get(taskId);
            if (reg) { reg.controller.abort(); await reg.settled; }
        } else if (task.status === "needs-human") {
            // No live loop — checkpoint (commitAll no-ops on a clean tree) and flip directly.
            if (task.worktreePath) await commitAll(task.worktreePath, "ralph: drop-in checkpoint");
            updateTask(db, taskId, { status: "handed-off" });
            notify();
        } else {
            return null; // queued (no worktree yet) / merged / abandoned — drop-in isn't offered
        }

        // Re-read: a merge that won the race may have landed the task merged (worktree gone) → don't launch.
        const current = getTask(db, taskId);
        if (!current || current.status !== "handed-off" || !current.worktreePath) return null;

        const sessionId = fresh ? null : latestSessionId(listIterations(db, taskId));

        if (project.terminalCommand == null) {
            // In-app tab: a main-resident PTY in the worktree, resuming the latest session (resilient shell).
            return ptyManager.create({
                cwd: current.worktreePath,
                argv: buildDropinArgv(sessionId),
                kind: "dropin",
                title: current.title,
                taskId,
                projectId: project.id,
            });
        }

        // External launch via the (unchanged) template — the project opted out of the in-app tab.
        const resume = sessionId ? `--resume ${sessionId}` : "";
        const launch = launchTerminal(project.terminalCommand, { worktree: current.worktreePath, resume });
        if (!launch.ok) {
            console.log(`[helm] terminal launch failed for task ${taskId}: ${launch.error}`);
            updateTask(db, taskId, { failureReason: `terminal launch failed: ${launch.error}` });
            notify();
        }
        return null;
    });

    // Resume the autonomous loop from the human's committed state: commit the handback, re-enqueue
    // (worktree retained → startTask resumes), kick. Honours pause (a paused fleet shows the manual Run).
    ipcMain.handle("tasks:resume", async (_e, taskId: string) => {
        const task = getTask(db, taskId);
        if (!task || task.status !== "handed-off") return;
        if (task.worktreePath) await commitAll(task.worktreePath, "ralph: handback");
        updateTask(db, taskId, { status: "queued" }); // worktreePath retained → resume discrimination
        notify();
        scheduler.kick();
    });

    // "I finished it — verify & merge": commit the handback, then the M4 merge stage, mutex-serialized
    // (no concurrency slot — drop-in freed it). Fire-and-forget; the task stays handed-off during the merge.
    ipcMain.handle("tasks:verifyAndMerge", (_e, taskId: string) => {
        const task = getTask(db, taskId);
        if (!task || task.status !== "handed-off") return; // guard a double-click / resume-then-verify
        const project = getProject(db, task.projectId);
        if (!project) return;
        const config = resolveLoopConfig(project);
        const taskBranch = task.branchName ?? `${project.branchPrefix}/task-${task.id}`;
        snapshots.dispatch(task.id, { type: "gate", index: 0, label: "merge: waiting" });
        void verifyAndMerge(project, task, taskBranch, buildHandbackDeps(config)).then(() => notify());
    });

    // Abandon: reap the retained worktree + branch, flag abandoned.
    ipcMain.handle("tasks:abandon", async (_e, taskId: string) => {
        const task = getTask(db, taskId);
        if (!task) return;
        const project = getProject(db, task.projectId);
        if (!project) return;
        const config = resolveLoopConfig(project);
        const taskBranch = task.branchName ?? `${project.branchPrefix}/task-${task.id}`;
        await abandon(project, task, taskBranch, buildHandbackDeps(config));
        notify();
    });

    // Observability reads. getVerifyState prefers the live snapshot (with its in-memory feed) and
    // falls back to one rebuilt from durable DB rows (empty feed) for inactive/restarted tasks.
    ipcMain.handle("tasks:verifyState", (_e, taskId: string) => {
        const live = snapshots.get(taskId);
        if (live) return live;
        const task = getTask(db, taskId);
        return task ? snapshotFromRows(task, listIterations(db, taskId)) : null;
    });
    ipcMain.handle("tasks:progress", (_e, taskId: string): string | null => {
        const task = getTask(db, taskId);
        if (!task?.worktreePath) return null; // worktree gone (terminal cleanup) → no progress file
        try { return readFileSync(join(task.worktreePath, ".ralph", "progress.md"), "utf8"); }
        catch { return null; }
    });

    // ── M7 embedded terminal IPC (spec §8/§4) ─────────────────────────────────────────────────────
    // Drive the single PtyManager. attach wires the main-side scrollback-replay-then-live stream to the
    // renderer via pty:data (utf8 strings are fine at v1 volumes); detach stops it WITHOUT killing (a
    // closed view ≠ a closed session). Kill is the only thing that ends a session; disposePtys (Quit)
    // ends them all. The drop-in retrofit (tasks:dropIn) creates its session in-process via ptyManager
    // directly — these handlers are the general surface the renderer + M8 free-tabs also use.
    ipcMain.handle("pty:create", (_e, opts: CreatePtyOptions) => ptyManager.create(opts));
    ipcMain.handle("pty:write", (_e, id: string, data: string) => { ptyManager.write(id, data); });
    ipcMain.handle("pty:resize", (_e, id: string, cols: number, rows: number) => { ptyManager.resize(id, cols, rows); });
    ipcMain.handle("pty:kill", (_e, id: string) => { ptyManager.kill(id); });
    ipcMain.handle("pty:list", () => ptyManager.list());
    ipcMain.handle("pty:attach", (_e, id: string) => { ptyManager.attach(id, (chunk) => getWindow()?.webContents.send("pty:data", id, chunk)); });
    ipcMain.handle("pty:detach", (_e, id: string) => { ptyManager.detach(id); });

    // ── M10 plan ingestion (spec §3) ──────────────────────────────────────────────────────────────
    // Open (or reuse) a project's planner: ensure the .helm/plan/ drop dir + git-exclude .helm/, start the
    // live watcher (pushes plan:changed as prd.md/tasks.json land), and create-or-reuse the HUMAN planner
    // PTY (kind "planner", cwd repoPath, a resilient `pwsh -NoExit` wrapping `claude`, default permission
    // mode — NOT through spawn.ts). Returns that session + the initial rail state so the view renders at once.
    ipcMain.handle("plans:openPlanner", (_e, projectId: string): { session: PtySession; state: PlanRailState } | null => {
        const project = getProject(db, projectId);
        if (!project) return null;
        const dir = planDirFor(project.repoPath);
        mkdirSync(dir, { recursive: true });
        ensureHelmExcluded(project.repoPath);

        if (!planWatchers.has(projectId)) {
            planWatchers.set(projectId, watchPlanDir(dir, () => {
                getWindow()?.webContents.send("plan:changed", projectId, readPlanRailState(project.repoPath));
            }));
        }

        const alive = ptyManager.list().find((s) => s.kind === "planner" && s.projectId === projectId && s.alive);
        let session: PtySession;
        if (alive) { const { alive: _a, ...meta } = alive; session = meta; }
        else session = ptyManager.create({ cwd: project.repoPath, argv: ["pwsh.exe", "-NoExit", "-Command", "claude"], kind: "planner", title: `${project.name} — plan`, projectId });

        return { session, state: readPlanRailState(project.repoPath) };
    });

    // M11 plan views (reads): the two joins the board's plan badge + plan-detail need. db/plans.ts already
    // holds the fns; these just surface them (getPlan → null so the renderer's `| null` handle is honoured).
    ipcMain.handle("plans:list", (_e, projectId: string) => listPlans(db, projectId));
    ipcMain.handle("plans:get", (_e, planId: string) => getPlan(db, planId) ?? null);

    // M11 dynamic pre-flight (phase 1 of the two-phase approve): re-read + re-validate from disk, then EXECUTE
    // each acceptance command once in a throwaway worktree off the integration tip and classify it. A still-
    // invalid draft yields the parse errors (hard-block, exactly like approve). NO merge mutex — pre-flight is
    // read-only validation off whatever tip it sees; racing a merge is harmless (validated one merge old at worst).
    ipcMain.handle("plans:preflight", async (_e, projectId: string): Promise<PreflightRunResult> => {
        const project = getProject(db, projectId);
        if (!project) return { ok: false, errors: [`unknown project ${projectId}`] };
        const files = readPlanFiles(planDirFor(project.repoPath));
        if (files.tasksJson == null) return { ok: false, errors: ["no tasks.json in .helm/plan/ to pre-flight"] };
        const parsed = parsePlanDraft(files.tasksJson);
        if (!parsed.ok) return { ok: false, errors: parsed.errors };
        const staticV = staticPreflight(parsed.draft, planCtx(project.repoPath));
        // A thrown pre-flight (bad repo state, git failure) must reach the renderer as a STRUCTURED error, never
        // an ipc rejection — the M10-acceptance finding: an uncaught rejection left the rail stuck on "loading".
        try {
            const report = await runPreflight(project, parsed.draft, staticV, buildPreflightDeps(resolveLoopConfig(project)));
            return { ok: true, report };
        } catch (err) {
            return { ok: false, errors: [`pre-flight failed: ${(err as Error)?.message ?? String(err)}`] };
        }
    });

    // Approve the active plan: re-read + re-validate from disk (never the renderer's copy — it can be stale or
    // spoofed). Any parse failure → structured rejection, NO rows. Then the M11 gate: unless the human explicitly
    // Skipped pre-flight, RE-RUN pre-flight from disk and re-assert every warn is acked (the renderer's report is
    // never trusted). Only past the gate, in ONE transaction: insertPlan (PRD text copied; missing prd.md →
    // stored "" + a warn, so approve isn't wedged) then the tasks in topological order, resolving slug edges to
    // the real ids (the M9 column). After commit: clear the drop dir (rows are now durable), refresh the board,
    // kick the scheduler (honours pause). The just-queued tasks then flow through the merged-gate like hand-made ones.
    ipcMain.handle("plans:approve", async (_e, projectId: string, opts?: ApproveOptions): Promise<ApprovePlanResult> => {
        const project = getProject(db, projectId);
        if (!project) return { ok: false, errors: [`unknown project ${projectId}`] };
        const dir = planDirFor(project.repoPath);
        const files = readPlanFiles(dir);
        if (files.tasksJson == null) return { ok: false, errors: ["no tasks.json in .helm/plan/ to approve"] };

        const approved = approveFromTasksJson(files.tasksJson, files.prdText, () => randomUUID());
        if (!approved.ok) return { ok: false, errors: approved.errors }; // parse-invalid → NO rows

        // The ack gate. Skip is an explicit human escape (a hurry stays in control); otherwise re-run pre-flight
        // on the SAME (just-parsed) draft and require every warn command to be in the acks. Parse-FAILs already bailed.
        if (!opts?.skipPreflight) {
            const parsed = parsePlanDraft(files.tasksJson);
            if (parsed.ok) {
                const staticV = staticPreflight(parsed.draft, planCtx(project.repoPath));
                let report;
                try {
                    report = await runPreflight(project, parsed.draft, staticV, buildPreflightDeps(resolveLoopConfig(project)));
                } catch (err) {
                    // Same structured-error rule as plans:preflight: a throw here must not reject the approve ipc.
                    return { ok: false, errors: [`pre-flight failed: ${(err as Error)?.message ?? String(err)}`] };
                }
                const unacked = unackedWarnCommands(report, opts?.acks ?? []);
                if (unacked.length) return { ok: false, errors: [`pre-flight has ${unacked.length} unacknowledged warning(s) — acknowledge each or Skip pre-flight:`, ...unacked] };
            }
        }

        const warnings = files.prdText == null ? ["no prd.md in .helm/plan/ — stored an empty PRD for this plan"] : [];
        db.transaction(() => {
            const plan = insertPlan(db, { projectId, title: approved.plan.planTitle, prdText: approved.plan.prdText });
            for (const ins of approved.plan.inserts) insertPlanTask(db, { ...ins, projectId, planId: plan.id });
        })();

        clearPlanDir(dir);
        getWindow()?.webContents.send("plan:changed", projectId, readPlanRailState(project.repoPath));
        notify();
        scheduler.kick();
        return { ok: true, count: approved.plan.inserts.length, warnings };
    });

    // ── M6 ① boot reconcile (spec §4 "process death is cheap") ────────────────────────────────────
    // Close out the interrupted turn's still-open iteration: mark it FAILED, and — critically — leave
    // sessionId NULL (the M5 resume-guard: a crash-killed turn persisted no resumable claude session, so
    // drop-in's latestSessionId must not target it). Never passes sessionId.
    const closeOutDangling = (taskId: string): void => {
        const last = listIterations(db, taskId).at(-1);
        if (last && last.endedAt == null) {
            finishIteration(db, last.id, { gateVerdict: "failed", outputTail: "interrupted by shutdown/crash" });
        }
    };

    // Reconcile ONE project's DB ↔ git: list git state, filter to worktrees under worktreeDir (the
    // reconcile safety contract — the primary checkout must never reach the planner), plan with the pure
    // reconcile(), then apply each action with real git/DB fns. Its real effects are covered by manual
    // acceptance (a headless slice with fake git can't prove real reconciliation).
    const runReconcile = async (project: Project): Promise<void> => {
        const config = resolveLoopConfig(project);
        const wts = (await listWorktrees(project.repoPath)).filter((w) => isUnderWorktreeDir(w.path, project.repoPath, project.worktreeDir));
        const branches = await listBranches(project.repoPath);
        const tasks = listTasks(db).filter((t) => t.projectId === project.id);
        const byId = new Map(tasks.map((t) => [t.id, t]));

        for (const action of reconcile(tasks, { worktrees: wts, branches })) {
            switch (action.type) {
                case "requeue": {
                    // Intact worktree → close out the dangling iteration, checkpoint any dirty bytes
                    // (commitAll no-ops on a clean tree), flip to queued. worktreePath RETAINED → the boot
                    // kick resumes it via the M5 resume path (worktreePath != null discriminator).
                    closeOutDangling(action.taskId);
                    const task = byId.get(action.taskId);
                    if (task?.worktreePath) await commitAll(task.worktreePath, "ralph: crash-recovery checkpoint");
                    updateTask(db, action.taskId, { status: "queued" });
                    break;
                }
                case "rebuild": {
                    // Worktree gone but branch alive → recreate the worktree from the branch tip, reseed the
                    // lost .ralph files (progress.md was in the lost worktree; the committed code on the branch
                    // is intact), reinstall deps, then queue it. Resume mode then skips clone/.ralph/setup.
                    const task = byId.get(action.taskId);
                    if (!task) break;
                    closeOutDangling(action.taskId);
                    const path = worktreePathFor(project.repoPath, project.worktreeDir, action.branch);
                    await addWorktreeForBranch(project.repoPath, path, action.branch);
                    ensureRalphExcluded(project.repoPath);
                    writeRalphFiles(path, { instructions: buildInstructions(), progress: seedProgress(task), task: buildTaskDirective(task) });
                    if (project.setupCommand) await runSetup(path, project.setupCommand, config.checkTimeoutMs);
                    updateTask(db, action.taskId, { worktreePath: path, status: "queued" });
                    break;
                }
                case "to-needs-human": {
                    closeOutDangling(action.taskId);
                    updateTask(db, action.taskId, { status: "needs-human", failureReason: action.reason });
                    break;
                }
                case "prune-worktree": {
                    // M8: reap any human shell holding the orphan worktree dir BEFORE removing it (a live
                    // pwsh EBUSY-wedges the removal on Windows). reconcile only ever prunes helm throwaways /
                    // no-owner / terminal-owned worktrees — never a handed-off/needs-human/requeued one — so
                    // this never kills a shell in a worktree the human is still meant to be steering.
                    ptyManager.killByCwdPrefix(action.path);
                    // Tolerant — a partially-removed worktree may throw; the postcondition "gone" is what matters.
                    try { await removeWorktree(project.repoPath, action.path, action.branch ?? "", false); }
                    catch (e) { console.log(`[helm] prune skipped for ${action.path}: ${e instanceof Error ? e.message : String(e)}`); }
                    break;
                }
            }
        }
        notify(); // reflect the reconciled state on the board
    };

    // Boot: reconcile each project's DB ↔ git (crash-resume + orphan-prune) BEFORE the kick — a
    // requeued/rebuilt task must be `queued` in the DB before the scheduler scans, or it's skipped until
    // the next event. Then auto-start any queued tasks (created this session or in a prior one — the
    // scheduler is otherwise event-driven and would leave them idle). Each project's reconcile is wrapped
    // so one bad repo (e.g. deleted on disk) logs + skips rather than aborting the whole boot.
    void (async () => {
        for (const project of listProjects(db)) {
            try { await runReconcile(project); }
            catch (e) { console.log(`[helm] reconcile failed for project ${project.id}: ${e instanceof Error ? e.message : String(e)}`); }
        }
        scheduler.kick();
    })();

    // The soft hourly check-in (spec §5.3): an OS Notification each interval with the live iteration
    // count + latest activity. Never kills; cleared when the loop terminates. Pure cadence math lives
    // in checkIn.ts — this is the untested Electron edge.
    function startCheckInTimer(taskId: string): () => void {
        const startedAt = Date.now();
        let fired = 0;
        const id = setInterval(() => {
            const due = checkInsDue(Date.now() - startedAt);
            if (due <= fired) return;
            fired = due;
            const snap = snapshots.get(taskId);
            const iters = snap?.iterations.length ?? 0;
            const activity = snap?.currentIteration?.latestActivity || "(working)";
            new Notification({ title: `Helm — task still running (${iters} iteration${iters === 1 ? "" : "s"})`, body: activity }).show();
        }, CHECKIN_POLL_MS);
        return () => clearInterval(id);
    }

    // Handed to index.ts's before-quit: a real Quit kills every live PTY session (no orphan pwsh/conhost)
    // and closes every plan watcher (M10). A window-hide (M6-④ tray) must NOT call this — sessions + watchers
    // keep running in the main process.
    return { disposePtys: () => { for (const dispose of planWatchers.values()) dispose(); planWatchers.clear(); ptyManager.disposeAll(); } };
}
