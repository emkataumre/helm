// src/renderer/views/Terminals.tsx
// Embedded terminals view — the design's full-view tab strip over every live PTY session,
// rendered with the real xterm TerminalPane (attach-on-mount replays the main-side
// scrollback; unmount detaches, never kills). Closing a tab IS killing the session — a
// distinct, confirmed act (§8.5); dead sessions stay listed greyed ("exited") until closed.
import { useContext, useState } from "react";
import type { Project, PtySessionInfo } from "../../shared/types";
import { Badge, Icon, IconButton, Select, Tooltip } from "../ds";
import type { IconName } from "../ds";
import { verifyAttrs } from "../components/verifyAttrs";
import { TerminalPane } from "../components/TerminalPane";
import { ActionCtx, ConfirmDialog, EmptyState, Mono, type TaskVM } from "./helpers";

const KIND_ICON: Record<PtySessionInfo["kind"], IconName> = { dropin: "Anchor", planner: "Map", free: "SquareChevronRight" };
const KIND_LABEL: Record<PtySessionInfo["kind"], string> = { dropin: "drop-in", planner: "planner", free: "shell" };

export function TerminalsView({ sessions, activeId, onSelect, onKill, onNewShell, projects, tasksById }: {
    sessions: PtySessionInfo[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onKill: (id: string) => void;
    onNewShell: (projectId: string) => void;
    projects: Project[];
    tasksById: Record<string, TaskVM>;
}) {
    const [confirmKill, setConfirmKill] = useState<PtySessionInfo | null>(null);
    const actions = useContext(ActionCtx);
    const active = sessions.find((s) => s.id === activeId) ?? sessions.find((s) => s.alive) ?? sessions[0];
    const taskOf = active?.taskId ? tasksById[active.taskId] : undefined;
    const liveCount = sessions.filter((s) => s.alive).length;
    return (
        <div className="helm-content helm-fade-in" {...verifyAttrs({ unit: "TerminalsView", count: sessions.length, live: liveCount, active: active?.id ?? null })} style={{ height: "100%" }}>
            <div style={{ padding: "14px var(--pad-view) 0", background: "var(--surface-app)", borderBottom: "1px solid var(--border-subtle)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, paddingBottom: 12 }}>
                    <h1 style={{ margin: 0, font: "var(--role-title)", letterSpacing: "var(--tracking-tight)" }}>Terminals</h1>
                    <Mono dim size="var(--text-xs)">{liveCount} live</Mono>
                    <span style={{ flex: 1 }}></span>
                    <Select size="sm" value="" onChange={(e) => { if (e.target.value) { onNewShell(e.target.value); e.currentTarget.value = ""; } }}
                        options={[{ value: "", label: "Open shell in…" }, ...projects.map((p) => ({ value: p.id, label: p.name + " — repo root" }))]} />
                </div>
                <div style={{ display: "flex", gap: 4, overflowX: "auto" }}>
                    {sessions.map((s) => (
                        <div key={s.id} onClick={() => onSelect(s.id)}
                            style={{
                                display: "flex", alignItems: "center", gap: 8, padding: "7px 8px 7px 12px", cursor: "pointer",
                                borderRadius: "8px 8px 0 0", border: "1px solid var(--border-subtle)", borderBottom: "none",
                                background: active && s.id === active.id ? "var(--surface-base)" : "transparent",
                                color: s.alive ? (active && s.id === active.id ? "var(--text-primary)" : "var(--text-secondary)") : "var(--text-faint)",
                                fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap", userSelect: "none",
                            }}>
                            <Icon name={KIND_ICON[s.kind]} size={13} style={{ color: s.alive ? "var(--amber-400)" : "var(--text-faint)" }} />
                            {s.title}
                            {!s.alive && <span style={{ color: "var(--text-faint)" }}>· exited</span>}
                            <Tooltip label={s.alive ? "Kill session — closing is killing" : "Remove from list"}>
                                <IconButton size="sm" label="Kill session" onClick={(e) => { e.stopPropagation(); if (s.alive) setConfirmKill(s); else onKill(s.id); }}>
                                    <Icon name="X" size={12} />
                                </IconButton>
                            </Tooltip>
                        </div>
                    ))}
                </div>
            </div>

            {active ? (
                <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 10, padding: "var(--pad-view)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <Badge variant="outline">{KIND_LABEL[active.kind]}</Badge>
                        <Mono dim size="var(--text-2xs)">{active.cwd}</Mono>
                        {taskOf && (
                            <a onClick={() => actions.openTask(taskOf.id)} style={{ cursor: "pointer", fontSize: "var(--text-xs)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                                <Icon name="ArrowUpRight" size={12} /> {taskOf.title}
                            </a>
                        )}
                        <span style={{ flex: 1 }}></span>
                        <Mono dim size="var(--text-2xs)">hiding this view keeps the session alive — closing kills it</Mono>
                    </div>
                    <div style={{ flex: 1, minHeight: 0 }}>
                        {/* keyed by id: a tab switch remounts the pane → re-attach + scrollback replay */}
                        <TerminalPane key={active.id} session={active} />
                    </div>
                </div>
            ) : (
                <EmptyState icon="Terminal" line="No sessions. Open a shell, drop into a task, or start a planner." />
            )}

            <ConfirmDialog open={!!confirmKill} title="Kill this session?"
                body={confirmKill ? <span>「<Mono>{confirmKill.title}</Mono>」 is a live PTY. Killing it ends the process — switching away or hiding the window would have kept it running.</span> : null}
                confirmLabel="Kill session" danger
                onConfirm={() => confirmKill && onKill(confirmKill.id)} onClose={() => setConfirmKill(null)} />
        </div>
    );
}
