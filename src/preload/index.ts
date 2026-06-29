import { contextBridge, ipcRenderer } from "electron";
import type { HelmApi } from "../shared/types";

const api: HelmApi = {
    registerProject: (input) => ipcRenderer.invoke("projects:register", input),
    listProjects: () => ipcRenderer.invoke("projects:list"),
    updateProject: (id, patch) => ipcRenderer.invoke("projects:update", id, patch),
    createTask: (input) => ipcRenderer.invoke("tasks:create", input),
    listTasks: () => ipcRenderer.invoke("tasks:list"),
    runTask: (taskId) => ipcRenderer.invoke("tasks:run", taskId),
    getVerifyState: (taskId) => ipcRenderer.invoke("tasks:verifyState", taskId),
    getProgress: (taskId) => ipcRenderer.invoke("tasks:progress", taskId),
    onTasksChanged: (cb) => { ipcRenderer.on("tasks:changed", () => cb()); },
    onSnapshotChanged: (cb) => { ipcRenderer.on("snapshot:changed", (_e, taskId: string) => cb(taskId)); },
};
contextBridge.exposeInMainWorld("helm", api);
