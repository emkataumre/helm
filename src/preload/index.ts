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
