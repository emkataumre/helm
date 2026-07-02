import { contextBridge, ipcRenderer } from "electron";
import type { HelmApi } from "../shared/types";

const api: HelmApi = {
    registerProject: (input) => ipcRenderer.invoke("projects:register", input),
    listProjects: () => ipcRenderer.invoke("projects:list"),
    updateProject: (id, patch) => ipcRenderer.invoke("projects:update", id, patch),
    detectProject: (repoPath) => ipcRenderer.invoke("projects:detect", repoPath),
    promote: (projectId) => ipcRenderer.invoke("projects:promote", projectId),
    createTask: (input) => ipcRenderer.invoke("tasks:create", input),
    listTasks: () => ipcRenderer.invoke("tasks:list"),
    startNow: (taskId) => ipcRenderer.invoke("tasks:startNow", taskId),
    getSchedulerState: () => ipcRenderer.invoke("scheduler:state"),
    setSchedulerPaused: (paused) => ipcRenderer.invoke("scheduler:setPaused", paused),
    dropIn: (taskId, fresh) => ipcRenderer.invoke("tasks:dropIn", taskId, fresh),
    resumeTask: (taskId) => ipcRenderer.invoke("tasks:resume", taskId),
    verifyAndMerge: (taskId) => ipcRenderer.invoke("tasks:verifyAndMerge", taskId),
    abandon: (taskId) => ipcRenderer.invoke("tasks:abandon", taskId),
    getVerifyState: (taskId) => ipcRenderer.invoke("tasks:verifyState", taskId),
    getProgress: (taskId) => ipcRenderer.invoke("tasks:progress", taskId),
    onTasksChanged: (cb) => { ipcRenderer.on("tasks:changed", () => cb()); },
    onSnapshotChanged: (cb) => { ipcRenderer.on("snapshot:changed", (_e, taskId: string) => cb(taskId)); },
};
contextBridge.exposeInMainWorld("helm", api);
