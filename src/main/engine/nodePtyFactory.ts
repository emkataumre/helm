// src/main/engine/nodePtyFactory.ts
// The ONE place node-pty is imported (kept off the pure PtyManager so no test/verify-slice ever loads
// the native module — abi:node stays better-sqlite3-only). Adapts node-pty to the manager's PtyHandle.
// Untested Electron edge (the native/ConPTY boundary — the M3 Notification / M5 launchTerminal precedent).
//
// useConptyDll is LOAD-BEARING (the 2026-07-05 "my terminals randomly die" incident): with the OS-conpty
// branch, node-pty's kill() forks a conpty_console_list_agent that CRASHES under Electron ("AttachConsole
// failed"), so its 5s timeout fallback process.kill()s the shell's pid ~5s after the native kill freed
// it — a recycled-PID stray fire that terminates a random innocent process machine-wide (users saw
// unrelated terminal tabs die). The bundled-conpty.dll branch kills via _ptyNative.kill alone: instant
// client termination (abandon's reap race needs kill latency in ms, not taskkill's ~100-300ms), no agent
// fork, no delayed process.kill. killTree stays as the grandchild belt, fired BEFORE proc.kill() so
// taskkill /T enumerates the tree while the root pid is still alive (zero PID-reuse window).
import { spawn as ptySpawn } from "node-pty";
import { killTree } from "./exec";
import type { PtyFactory } from "./ptyManager";

export const nodePtyFactory: PtyFactory = (cmd, args, opts) => {
    // useConpty defaults to true on Win11 (build ≥ 18309 — spike-confirmed); useConptyDll routes kill()
    // through the bundled conpty.dll's clean branch (see header — the stray-fire fix).
    const proc = ptySpawn(cmd, args, {
        name: "xterm-color",
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        // M16: the manager passes the human-PTY env overlay (ctl pipe + shim PATH); absent → plain
        // process.env, byte-identical to before. process.env itself is never mutated.
        env: opts.env ?? (process.env as Record<string, string>),
        useConptyDll: true,
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
            killTree(proc.pid); // belt FIRST, while the root lives — no PID-reuse window (see header)
            try { proc.kill(); } catch { /* already gone */ } // instant ConPTY close via conpty.dll
        },
    };
};
