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
