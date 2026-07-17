// src/renderer/views/DetachedTerminal.tsx
// The full-window host for a terminal that has been UNPINNED into its own OS window (see
// src/main/engine/terminalWindow.ts). A detached BrowserWindow loads the same renderer bundle with a
// `?terminal=<id>&kind=…&title=…&cwd=…` query; main.tsx parses it and mounts THIS instead of the cockpit.
//
// It reuses the ONE real xterm TerminalPane, so the detached window streams the SAME main-resident PTY
// (attach-on-mount replays the scrollback, keystrokes route back through window.helm.ptyWrite) — the pty
// process never moves, only its host window does. CLOSING this OS window pins the terminal back into the
// in-app tiling (main wires win.on("closed") → registry.windowClosed → reattach), so no button is needed
// for the pin-back direction.
import type { PtyKind, PtySession } from "../../shared/types";
import { TerminalPane } from "../components/TerminalPane";
import { verifyAttrs } from "../components/verifyAttrs";

const KINDS: readonly PtyKind[] = ["dropin", "planner", "free"];
const asKind = (v: string | null): PtyKind => (KINDS as readonly string[]).includes(v ?? "") ? (v as PtyKind) : "free";

// Parse the detached-window query into a minimal PtySession (id is the only hard requirement — it's the
// stable PTY key everything routes on). Returns null for the normal main window (no `terminal` param), so
// the caller mounts the cockpit instead. Pure + total: a malformed query degrades to sensible defaults.
export function parseDetachedTerminal(search: string): PtySession | null {
    const q = new URLSearchParams(search);
    const id = q.get("terminal");
    if (!id) return null;
    const session: PtySession = { id, kind: asKind(q.get("kind")), title: q.get("title") ?? "Terminal", cwd: q.get("cwd") ?? "" };
    const taskId = q.get("taskId");
    const projectId = q.get("projectId");
    if (taskId) session.taskId = taskId;
    if (projectId) session.projectId = projectId;
    return session;
}

export function DetachedTerminal({ session }: { session: PtySession }) {
    return (
        <div {...verifyAttrs({ unit: "DetachedTerminal", session: session.id, kind: session.kind })}
            style={{ position: "fixed", inset: 0, background: "#08090C", display: "flex", flexDirection: "column" }}>
            <div style={{ flex: 1, minHeight: 0 }}>
                <TerminalPane session={session} />
            </div>
        </div>
    );
}
