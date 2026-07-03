// src/renderer/components/TerminalTabs.tsx
// The M8 tab strip: one tab per live PtySession, sourced from pty:list (main-process residency → the tabs
// survive a window-hide). Pure and prop-driven — click a tab to focus it (the host attaches → scrollback
// replays), the × closes it (= pty:kill; the ONLY renderer-initiated kill, an explicit user action). A dead
// session (alive=false) greys out until its exit event prunes it. The active pane itself is the TerminalPane
// the host mounts for `activeId`; this component is just the strip, render-tested via renderToStaticMarkup.
import type { PtySessionInfo } from "../../shared/types";
import { verifyAttrs } from "./verifyAttrs";

const KIND_COLOR: Record<string, string> = { dropin: "#D97757", planner: "#788C5D", free: "#8a8a85" };

export function TerminalTabs({ sessions, activeId, onFocus, onClose }: {
    sessions: PtySessionInfo[];
    activeId: string | null;
    onFocus: (id: string) => void;
    onClose: (id: string) => void;
}) {
    const stop = (fn: () => void) => (e: { stopPropagation: () => void }) => { e.stopPropagation(); fn(); };
    return (
        <div
            {...verifyAttrs({ unit: "TerminalTabs", count: sessions.length, active: activeId })}
            style={{ display: "flex", gap: 4, alignItems: "center", flex: 1, minWidth: 0, overflowX: "auto" }}
        >
            {sessions.map((s) => {
                const active = s.id === activeId;
                return (
                    <div
                        key={s.id}
                        {...verifyAttrs({ unit: "TerminalTab", session: s.id, kind: s.kind, active, alive: s.alive })}
                        onClick={() => onFocus(s.id)}
                        title={s.cwd}
                        style={{
                            display: "flex", alignItems: "center", gap: 6, padding: "3px 8px", borderRadius: 8,
                            cursor: "pointer", fontFamily: "ui-monospace, monospace", fontSize: 12, whiteSpace: "nowrap",
                            background: active ? "#141413" : "transparent",
                            color: s.alive ? "#FAF9F5" : "#6b6b66",
                            border: `1px solid ${active ? "#3D3D3A" : "transparent"}`,
                        }}
                    >
                        <span style={{ width: 6, height: 6, borderRadius: 3, background: KIND_COLOR[s.kind] ?? "#8a8a85", flexShrink: 0 }} />
                        <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>{s.title}</span>
                        <span style={{ textTransform: "uppercase", fontSize: 9, color: "#788C5D", letterSpacing: 0.5 }}>{s.kind}</span>
                        <button
                            onClick={stop(() => onClose(s.id))}
                            title="Close terminal (kills this session)"
                            style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, lineHeight: 1 }}
                        >×</button>
                    </div>
                );
            })}
        </div>
    );
}
