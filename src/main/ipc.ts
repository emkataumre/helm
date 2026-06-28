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
