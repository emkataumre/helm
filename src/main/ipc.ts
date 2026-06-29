// src/main/ipc.ts
import { ipcMain, Notification, type BrowserWindow } from "electron";
import { app } from "electron";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { openDb } from "./db/db";
import { insertProject, listProjects, getProject, updateProject } from "./db/projects";
import { insertTask, listTasks, getTask, updateTask } from "./db/tasks";
import { addIteration, finishIteration, listIterations } from "./db/iterations";
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
import { resolveLoopConfig } from "./engine/loopConfig";
import { detectProjectConfig } from "./engine/detect";
import { checkInsDue } from "./engine/checkIn";
import { runTaskLoop, type RunTaskDeps } from "./engine/runTask";
import type { NewProjectInput, NewTaskInput, ProjectConfigPatch, TaskStatus } from "../shared/types";

const CHECKIN_POLL_MS = 60_000; // re-evaluate the check-in cadence each minute

export function registerIpc(getWindow: () => BrowserWindow | null): void {
    const db = openDb(join(app.getPath("userData"), "helm.db"));
    const logsDir = join(app.getPath("userData"), "logs");
    const notify = () => getWindow()?.webContents.send("tasks:changed");
    // One live EngineSnapshot per active task; each dispatch nudges the renderer's detail view.
    const snapshots = createSnapshotStore((taskId) => getWindow()?.webContents.send("snapshot:changed", taskId));

    ipcMain.handle("projects:register", (_e, input: NewProjectInput) => insertProject(db, input));
    ipcMain.handle("projects:list", () => listProjects(db));
    ipcMain.handle("projects:update", (_e, id: string, patch: ProjectConfigPatch) => { updateProject(db, id, patch); notify(); return getProject(db, id) ?? null; });
    ipcMain.handle("projects:detect", (_e, repoPath: string) => detectProjectConfig(repoPath));
    ipcMain.handle("tasks:create", (_e, input: NewTaskInput) => { const t = insertTask(db, input); notify(); return t; });
    ipcMain.handle("tasks:list", () => listTasks(db));

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

    ipcMain.handle("tasks:run", async (_e, taskId: string): Promise<TaskStatus> => {
        const task = getTask(db, taskId);
        if (!task) throw new Error(`unknown task ${taskId}`);
        const project = getProject(db, task.projectId);
        if (!project) throw new Error(`unknown project ${task.projectId}`);

        const config = resolveLoopConfig(project); // nullable project columns → concrete bounds

        const deps: RunTaskDeps = {
            ensureBranch, checkoutBranch, createWorktree, removeWorktree,
            ensureRalphExcluded, writeRalphFiles,
            runSetup: async (wt, cmd, t) => {
                const res = await run(cmd, [], { cwd: wt, timeoutMs: t, shell: true });
                return { ok: res.code === 0 && !res.timedOut, output: `${res.stdout}\n${res.stderr}`.trim() };
            },
            // Inject the per-iteration raw-log sink (keyed by taskId + index) at the chokepoint.
            spawnAgent: (wt, prompt, opts) => spawnAgent(wt, prompt, { ...opts, logSink: createLogSink(logsDir, task.id, opts.iterationIndex ?? 0) }),
            commitAll, headSha,
            runCheck: (wt, cmd, t) => runCheck(wt, cmd, t),
            runAcceptance: (wt, cmds, t) => runAcceptance(wt, cmds, t),
            squashMergeInto, diffStat,
            // M4: landing goes through the isolated merge stage. Task 6 wraps this in the project's
            // merge mutex; until then a direct (unwrapped) wiring keeps the build green.
            mergeStage: (p, t, taskBranch) => {
                const mergeDeps: MergeStageDeps = {
                    createWorktree, squashMergeInto,
                    runSetup: async (wt, cmd, to) => {
                        const res = await run(cmd, [], { cwd: wt, timeoutMs: to, shell: true });
                        return { ok: res.code === 0 && !res.timedOut, output: `${res.stdout}\n${res.stderr}`.trim() };
                    },
                    runCheck: (wt, cmd, to) => runCheck(wt, cmd, to),
                    runAcceptance: (wt, cmds, to) => runAcceptance(wt, cmds, to),
                    removeWorktree, diffStat, advanceBranch, headSha,
                    checkTimeoutMs: config.checkTimeoutMs,
                    emit: (e) => snapshots.dispatch(t.id, e),
                };
                return runMergeStage(p, t, taskBranch, mergeDeps);
            },
            setStatus: (id, status, extra) => { updateTask(db, id, { status, ...extra }); notify(); },
            addIteration: (tid, idx) => addIteration(db, tid, idx),
            finishIteration: (id, patch) => finishIteration(db, id, patch),
            emit: (e) => snapshots.dispatch(task.id, e),
            log: (m) => console.log(`[helm] ${m}`),
        };

        const stopCheckIns = startCheckInTimer(task.id);
        try {
            const status = await runTaskLoop(project, task, config, deps);
            notify();
            return status;
        } finally {
            stopCheckIns();
        }
    });

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
