import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
import { join } from "node:path";
import { registerIpc } from "./ipc";

// M8.5 acceptance harness: redirect userData to a throwaway dir BEFORE anything opens the DB (registerIpc
// opens helm.db under app.getPath("userData") at whenReady). This runs at module load — earlier than the
// whenReady callback — so the override is always in force by the time the DB is opened. Set only by the
// accept harness (_electron.launch env); unset in real use → the real %APPDATA%\helm userData is untouched.
// This is what makes the real board unreachable BY CONSTRUCTION during an accept run.
if (process.env.HELM_USER_DATA) app.setPath("userData", process.env.HELM_USER_DATA);

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
        width: 1440,
        height: 900,
        // M14 cockpit chrome: the renderer draws its own 40px titlebar (brand, fleet counts,
        // pause switch) and Electron overlays the native min/max/close in the corner, colour-
        // matched to the design's --surface-app ink. Close still hides to tray (below).
        titleBarStyle: "hidden",
        titleBarOverlay: { color: "#0B0D11", symbolColor: "#6B7688", height: 40 },
        backgroundColor: "#0B0D11",
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
    // Initial tooltip; overwritten at once by registerIpc's startup refresh with the live fleet counts
    // (M12), then on every board change via the tasks:changed seam.
    tray.setToolTip("Helm — engine running");
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: "Show Helm", click: showWindow },
        { type: "separator" },
        { label: "Quit", click: () => { quitting = true; app.quit(); } },
    ]));
}

app.whenReady().then(() => {
    // Tray BEFORE registerIpc: registerIpc's startup refresh (and every later tasks:changed) sets the tray
    // tooltip via the callback, so the tray must already exist. Tray stays strictly here — ipc.ts hands us a
    // ready-made string derived by the pure trayCounts module (no Electron in that module).
    createTray();
    ({ disposePtys } = registerIpc(() => mainWindow, (tooltip) => tray?.setToolTip(tooltip)));
    createWindow();
});

// Tray-resident: hiding the window must NOT quit the app. No-op on all platforms.
app.on("window-all-closed", () => {});

// A real quit (tray Quit, OS shutdown) — flip the hide-on-close guard so the window closes, and kill
// every live PTY session (the only place sessions die — a window-hide leaves them running in main).
app.on("before-quit", () => { quitting = true; disposePtys(); });
