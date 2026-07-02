// src/main/engine/nodePtyFactory.ts
// The ONE place node-pty is imported (kept off the pure PtyManager so no test/verify-slice ever loads
// the native module — abi:node stays better-sqlite3-only). Adapts node-pty to the manager's PtyHandle.
// Untested Electron edge (the native/ConPTY boundary — the M3 Notification / M5 launchTerminal precedent).
//
// kill() pairs pty.kill() with the exec.ts killTree belt: the Task-1 spike proved ConPTY reaps the ROOT
// shell but node-pty's own grandchild reaper (a forked conpty_console_list_agent) throws "AttachConsole
// failed" under Electron, so taskkill /T /F is what guarantees no orphan pwsh/conhost/OpenConsole on Quit.
import { spawn as ptySpawn } from "node-pty";
import { killTree } from "./exec";
import type { PtyFactory } from "./ptyManager";

export const nodePtyFactory: PtyFactory = (cmd, args, opts) => {
    // useConpty defaults to true on Win11 (build ≥ 18309 — spike-confirmed); leave node-pty's defaults.
    const proc = ptySpawn(cmd, args, {
        name: "xterm-color",
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: process.env as Record<string, string>,
    });
    let killed = false;
    return {
        onData: (cb) => { proc.onData(cb); },
        onExit: (cb) => { proc.onExit(({ exitCode }) => cb(exitCode)); },
        // write/resize can race an exit; a throw here must not crash the main process.
        write: (data) => { try { proc.write(data); } catch { /* pty gone */ } },
        resize: (cols, rows) => { try { proc.resize(cols, rows); } catch { /* pty gone */ } },
        kill: () => {
            if (killed) return; // idempotent belt (the manager already guards, but be defensive)
            killed = true;
            const pid = proc.pid;
            try { proc.kill(); } catch { /* already gone */ }
            killTree(pid); // reap the tree the ConPTY close misses under Electron
        },
    };
};
