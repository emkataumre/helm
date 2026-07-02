// src/main/ipc.ts
import { ipcMain, Notification, type BrowserWindow } from "electron";
import { app } from "electron";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { openDb } from "./db/db";
import { insertProject, listProjects, getProject, updateProject, deleteProject } from "./db/projects";
import { insertTask, listTasks, getTask, updateTask } from "./db/tasks";
import { addIteration, finishIteration, listIterations, latestSessionId } from "./db/iterations";
import { ensureBranch, checkoutBranch, createWorktree, removeWorktree, listWorktrees, listBranches, addWorktreeForBranch, worktreePathFor } from "./engine/worktree";
import { reconcile, isUnderWorktreeDir } from "./engine/reconcile";
import { buildInstructions, seedProgress } from "./engine/prompt";
import { commitAll, squashMergeInto, diffStat, headSha, advanceBranch, fetchRemote, countCommitsBeyond, mergeNoFf, pushBranch, revParse } from "./engine/merge";
import { runMergeStage, type MergeStageDeps } from "./engine/mergeStage";
import { runPromoteStage, finalizePromotion, type PromoteStageDeps, type FinalizeDeps } from "./engine/promote";
import { runAcceptance } from "./engine/acceptance";
import { ensureRalphExcluded, writeRalphFiles } from "./engine/ralph";
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
import { runTaskLoop, type RunTaskDeps, type ResumeContext } from "./engine/runTask";
import { launchTerminal, DEFAULT_TERMINAL_COMMAND } from "./engine/terminalLaunch";
import { verifyAndMerge, abandon, type HandbackDeps } from "./engine/handback";
import { createPtyManager } from "./engine/ptyManager";
import { nodePtyFactory } from "./engine/nodePtyFactory";
import type { NewProjectInput, NewTaskInput, ProjectConfigPatch, Project, Task, TaskStatus, PromoteResponse, CreatePtyOptions } from "../shared/types";

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
    const buildHandbackDeps = (config: LoopConfig): HandbackDeps => ({
        commitAll,
        runMergeStage: (p, t, b) => scheduler.mutexFor(p.id).withLock(() => runMergeStage(p, t, b, buildMergeDeps(t.id, config))),
        setStatus: (id, status, extra) => { updateTask(db, id, { status, ...extra }); notify(); },
        removeWorktree,
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
    ipcMain.handle("tasks:list", () => listTasks(db).map((t) => ({ ...t, resumable: latestSessionId(listIterations(db, t.id)) != null })));

    // M4 scheduler IPC: paused-mode manual single-start, the live cockpit indicator state, pause toggle.
    ipcMain.handle("tasks:startNow", (_e, taskId: string) => { scheduler.startNow(taskId); });
    ipcMain.handle("scheduler:state", () => scheduler.state());
    ipcMain.handle("scheduler:setPaused", (_e, paused: boolean) => { scheduler.setPaused(paused); notify(); });

    // ── M5 drop-in handoff (spec §8) ────────────────────────────────────────────────────────────
    // Grab a running or needs-human task: hard-interrupt the live claude (freeing the slot), flip it to
    // handed-off (worktree retained), and launch a terminal resuming the latest session. `fresh` = Start
    // fresh (no --resume). Available from {running, needs-human} only.
    ipcMain.handle("tasks:dropIn", async (_e, taskId: string, fresh?: boolean) => {
        const task = getTask(db, taskId);
        if (!task) return;
        const project = getProject(db, task.projectId);
        if (!project) return;

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
            return; // queued (no worktree yet) / merged / abandoned — drop-in isn't offered
        }

        // Re-read: a merge that won the race may have landed the task merged (worktree gone) → don't launch.
        const current = getTask(db, taskId);
        if (!current || current.status !== "handed-off" || !current.worktreePath) return;

        const sessionId = fresh ? null : latestSessionId(listIterations(db, taskId));
        const resume = sessionId ? `--resume ${sessionId}` : "";
        const launch = launchTerminal(project.terminalCommand ?? DEFAULT_TERMINAL_COMMAND, { worktree: current.worktreePath, resume });
        if (!launch.ok) {
            console.log(`[helm] terminal launch failed for task ${taskId}: ${launch.error}`);
            updateTask(db, taskId, { failureReason: `terminal launch failed: ${launch.error}` });
            notify();
        }
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
                    writeRalphFiles(path, { instructions: buildInstructions(), progress: seedProgress(task) });
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

    // Handed to index.ts's before-quit: a real Quit kills every live PTY session (no orphan pwsh/conhost).
    // A window-hide (M6-④ tray) must NOT call this — sessions keep running in the main process.
    return { disposePtys: () => ptyManager.disposeAll() };
}
