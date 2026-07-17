// src/main/engine/ptyManager.ts
// The pure, DI'd home of ALL pty lifecycle (spec §8/§4). Electron-free and fake-able: node-pty is
// injected as a `PtyFactory`, so the native module NEVER loads in a test (the real factory is wired
// only in ipc.ts). Sessions live in the MAIN process, so they survive a window-hide (M6-④ tray) and a
// reopened window re-attaches with the scrollback ring intact; only a real Quit (disposeAll) kills them.
//
// SIBLING seam to spawn.ts — this is the humans-only terminal; agents keep going through the spawn
// chokepoint (the Docker-jail seam). Nothing here routes through spawn.ts.
//
// LEAF MODULE: imports only node:crypto + shared/types, so the verify slice drives the real manager
// with a fake factory (the dropin-slice pattern).
import { randomUUID } from "node:crypto";
import type { PtySession, PtySessionInfo, CreatePtyOptions } from "../../shared/types";
export type { CreatePtyOptions } from "../../shared/types";

// The one native surface, injected. The real factory (ipc.ts) adapts node-pty to this; every test and
// the verify slice supply a fake. `kill` in the real factory pairs pty.kill() with the exec.ts killTree
// belt (the Task-1 spike: ConPTY reaps the root but node-pty's grandchild reaper is broken under Electron).
export interface PtyHandle {
    onData(cb: (data: string) => void): void;
    onExit(cb: (exitCode: number) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
}
export type PtyFactory = (
    cmd: string,
    args: string[],
    // env (M16): the full environment for the session, or undefined = inherit the process env. The
    // manager forwards its injected human-PTY overlay here — the ctl pipe + shim PATH live ONLY in
    // this env, never in process.env (agents at the spawn.ts chokepoint stay pipe-blind).
    opts: { cwd: string; cols: number; rows: number; env?: Record<string, string> },
) => PtyHandle;

export interface PtyManager {
    create(opts: CreatePtyOptions): PtySession;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): void;                                  // idempotent; unknown/dead id → no-op
    attach(id: string, onData: (data: string) => void): void; // replays scrollback, then streams live
    detach(id: string): void;
    list(): PtySessionInfo[];
    onExit(cb: (id: string, exitCode: number) => void): void;
    killByCwdPrefix(prefix: string): void;                    // M8 worktree-reap primitive (built now)
    disposeAll(): void;                                       // the quit hook — kill everything live
}

// A bounded per-session scrollback ring (~200 KB of chars) — enough to repaint a reopened window's tab
// without unbounded memory. A single overflowing chunk is tail-sliced (may clip one leading escape on
// replay — cosmetic; xterm re-syncs). Kept as chars (utf8 strings are fine at v1 volumes, per the plan).
export const SCROLLBACK_CAP = 200_000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 30;

// Terminal QUERY / RESPONSE control sequences — Primary/Secondary Device Attributes (`ESC[c`, `ESC[>c`,
// and the `ESC[?1;2c` reply) and cursor-position / status reports (`ESC[6n`, `ESC[<r>;<c>R`) — must be
// stripped from a SCROLLBACK REPLAY. Re-feeding a historical DA/DSR *query* makes xterm re-answer it, and
// a shell sitting at its prompt echoes that answer as visible junk (the `[?1;2c` the user saw) which then
// re-enters the ring and GROWS on every re-attach (pin/unpin, reopened window). These are invisible
// control sequences, so removing them from the replay changes nothing a human sees — it only breaks the
// stale re-answer loop. LIVE streaming is untouched; only the history repaint is sanitised.
const REPLAY_QUERY_RE = /\x1b\[[?>=]?[0-9;]*[cn]|\x1b\[[0-9]+;[0-9]+R/g;
export function sanitizeReplay(ring: string): string {
    return ring.replace(REPLAY_QUERY_RE, "");
}

// Normalise slash style + trailing slash so a git/Windows cwd prefix match agrees regardless of
// representation (the reconcile normPath lesson). The `+ "/"` boundary stops `worktrees-evil` matching
// `worktrees`.
function normPath(p: string): string {
    return p.replace(/\\/g, "/").replace(/\/+$/, "");
}
function isUnderPrefix(cwd: string, prefix: string): boolean {
    const c = normPath(cwd);
    const p = normPath(prefix);
    return c === p || c.startsWith(p + "/");
}

interface Session {
    meta: PtySession;
    handle: PtyHandle;
    alive: boolean;
    ring: string;
    listener: ((data: string) => void) | null;
}

// env (M16): the optional human-PTY environment overlay — the FULL env every session here spawns with
// (in practice: process.env + HELM_CTL_PIPE + the ctl shim-dir PATH prepend, built once by buildCtlEnv
// at the ipc edge). This manager is the humans-only seam, so injecting here reaches the conductor pane,
// drop-in tabs and free terminals and NOTHING else — the agent chokepoint (spawn.ts) never sees it.
export function createPtyManager(factory: PtyFactory, env?: Record<string, string>): PtyManager {
    const sessions = new Map<string, Session>();
    const exitListeners: Array<(id: string, code: number) => void> = [];

    const create = (opts: CreatePtyOptions): PtySession => {
        const id = randomUUID();
        const meta: PtySession = { id, kind: opts.kind, title: opts.title, cwd: opts.cwd, taskId: opts.taskId, projectId: opts.projectId };
        const handle = factory(opts.argv[0], opts.argv.slice(1), { cwd: opts.cwd, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, env });
        const session: Session = { meta, handle, alive: true, ring: "", listener: null };

        handle.onData((chunk) => {
            session.ring += chunk;
            if (session.ring.length > SCROLLBACK_CAP) session.ring = session.ring.slice(session.ring.length - SCROLLBACK_CAP);
            session.listener?.(chunk);
        });
        handle.onExit((code) => {
            session.alive = false;
            // A subscriber that throws must NEVER break the manager (or the other subscribers).
            for (const cb of exitListeners) { try { cb(id, code); } catch { /* isolated */ } }
        });

        sessions.set(id, session);
        return meta;
    };

    const kill = (id: string): void => {
        const s = sessions.get(id);
        if (!s || !s.alive) return; // idempotent: unknown or already-dead → no-op
        s.alive = false;
        try { s.handle.kill(); } catch { /* a kill on an already-gone pty is fine */ }
    };

    return {
        create,
        write: (id, data) => { sessions.get(id)?.handle.write(data); },
        resize: (id, cols, rows) => { sessions.get(id)?.handle.resize(cols, rows); },
        kill,
        attach: (id, onData) => {
            const s = sessions.get(id);
            if (!s) return;
            if (s.ring.length) onData(sanitizeReplay(s.ring)); // replay scrollback (history paints; query/response sequences stripped so pin/unpin doesn't inject `[?1;2c`)…
            s.listener = onData;               // …then stream live (raw)
        },
        detach: (id) => { const s = sessions.get(id); if (s) s.listener = null; },
        list: () => [...sessions.values()].map((s) => ({ ...s.meta, alive: s.alive })),
        onExit: (cb) => { exitListeners.push(cb); },
        killByCwdPrefix: (prefix) => {
            for (const s of sessions.values()) if (s.alive && isUnderPrefix(s.meta.cwd, prefix)) kill(s.meta.id);
        },
        disposeAll: () => { for (const s of sessions.values()) if (s.alive) kill(s.meta.id); },
    };
}
