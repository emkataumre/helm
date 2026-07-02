import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
import { join } from "node:path";
import { registerIpc } from "./ipc";

let mainWindow: BrowserWindow | null = null;
// Hold the Tray in a module-level var — a local would be GC'd and vanish from the tray after a tick.
let tray: Tray | null = null;
// True only during a deliberate quit (tray Quit / OS before-quit); otherwise close means "hide".
let quitting = false;
// M7: kill every live PTY session on a real quit (no orphan pwsh/conhost). Assigned in whenReady;
// a no-op until then. A window-hide must NOT call this — sessions are main-process-resident.
let disposePtys: () => void = () => {};

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 760,
        webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs") },
    });
    if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    else mainWindow.loadFile(join(import.meta.dirname, "../renderer/index.html"));
    // Hide-on-close: the engine is tray-resident, so closing the window just hides it and the
    // loops keep grinding in the main process. Only a real quit (below) lets the window close.
    mainWindow.on("close", (e) => {
        if (!quitting) {
            e.preventDefault();
            mainWindow?.hide();
        }
    });
    mainWindow.on("closed", () => { mainWindow = null; });
}

function showWindow(): void {
    if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
    } else {
        createWindow();
    }
}

function createTray(): void {
    tray = new Tray(nativeImage.createFromPath(join(import.meta.dirname, "../../build/tray-icon.png")));
    tray.setToolTip("Helm — engine running");
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: "Show Helm", click: showWindow },
        { type: "separator" },
        { label: "Quit", click: () => { quitting = true; app.quit(); } },
    ]));
}

app.whenReady().then(() => {
    ({ disposePtys } = registerIpc(() => mainWindow));
    createTray();
    createWindow();
});

// Tray-resident: hiding the window must NOT quit the app. No-op on all platforms.
app.on("window-all-closed", () => {});

// A real quit (tray Quit, OS shutdown) — flip the hide-on-close guard so the window closes, and kill
// every live PTY session (the only place sessions die — a window-hide leaves them running in main).
app.on("before-quit", () => { quitting = true; disposePtys(); });
