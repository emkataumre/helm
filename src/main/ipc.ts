// src/main/ipc.ts
import { ipcMain, Notification, type BrowserWindow } from "electron";
import { app } from "electron";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { openDb } from "./db/db";
import { insertProject, listProjects, getProject, updateProject } from "./db/projects";
import { insertTask, listTasks, getTask, updateTask } from "./db/tasks";
import { addIteration, finishIteration, listIterations, latestSessionId } from "./db/iterations";
import { ensureBranch, checkoutBranch, createWorktree, removeWorktree } from "./engine/worktree";
import { commitAll, squashMergeInto, diffStat, headSha, advanceBranch } from "./engine/merge";
import { runMergeStage, type MergeStageDeps } from "./engine/mergeStage";
import { runAcceptance } from "./engine/acceptance";
import { ensureRalphExcluded, writeRalphFiles } from "./engine/ralph";
import { runCheck } from "./engine/check";
import { run } from "./engine/exec";
import { spawnAgent } from "./engine/spawn";
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
import type { NewProjectInput, NewTaskInput, ProjectConfigPatch, Task, TaskStatus } from "../shared/types";

const CHECKIN_POLL_MS = 60_000; // re-evaluate the check-in cadence each minute

export function registerIpc(getWindow: () => BrowserWindow | null): void {
    const db = openDb(join(app.getPath("userData"), "helm.db"));
    const logsDir = join(app.getPath("userData"), "logs");
    const notify = () => getWindow()?.webContents.send("tasks:changed");
    // One live EngineSnapshot per active task; each dispatch nudges the renderer's detail view.
    const snapshots = createSnapshotStore((taskId) => getWindow()?.webContents.send("snapshot:changed", taskId));

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
            // Inject the per-iteration raw-log sink (keyed by taskId + index) at the chokepoint.
            spawnAgent: (wt, prompt, opts) => spawnAgent(wt, prompt, { ...opts, logSink: createLogSink(logsDir, task.id, opts.iterationIndex ?? 0) }),
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
            finishIteration: (id, patch) => finishIteration(db, id, patch),
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
    ipcMain.handle("projects:detect", (_e, repoPath: string) => detectProjectConfig(repoPath));
    // Create → enqueue → kick: the scheduler auto-starts it when a slot is free (unless paused).
    ipcMain.handle("tasks:create", (_e, input: NewTaskInput) => { const t = insertTask(db, input); notify(); scheduler.kick(); return t; });
    ipcMain.handle("tasks:list", () => listTasks(db));

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

    // Boot: auto-start any tasks already queued (created in a prior session). The scheduler is
    // event-driven and otherwise only kicks on create/settle/resume/cap-change, so without this a
    // relaunch would leave queued tasks idle until the next event.
    scheduler.kick();

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
}
