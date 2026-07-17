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
import { TerminalTiling } from "../components/TerminalTiling";
import { ActionCtx, ConfirmDialog, EmptyState, Mono, type TaskVM } from "./helpers";

const KIND_ICON: Record<PtySessionInfo["kind"], IconName> = { dropin: "Anchor", planner: "Map", free: "SquareChevronRight" };
const KIND_LABEL: Record<PtySessionInfo["kind"], string> = { dropin: "drop-in", planner: "planner", free: "shell" };

// The Helm-side display label for a session — pure presentation, resolved at render time.
// Precedence: manual override → the bound task's title → the PTY's own default title. The
// session id is the stable resume key and is never derived from (or altered by) any of these.
export function sessionLabel(s: { id: string; title: string; taskId?: string }, tasksById: Record<string, TaskVM>, renames?: Record<string, string>): string {
    const manual = renames?.[s.id]?.trim();
    if (manual) return manual;
    if (s.taskId && tasksById[s.taskId]) return tasksById[s.taskId].title;
    return s.title;
}

// The two-level tab-strip filter: project first, then (within that project) task. The task level
// is deliberately inert without a project — it only ever narrows a project's own terminals.
// No filter (null, null) = the full list, untouched.
export function filterSessions(sessions: PtySessionInfo[], projectId: string | null, taskId: string | null): PtySessionInfo[] {
    if (!projectId) return sessions;
    return sessions.filter((s) => s.projectId === projectId && (!taskId || s.taskId === taskId));
}

export function TerminalsView({ sessions, activeId, onSelect, onKill, onNewShell, projects, tasksById, renames, onRename, initialFilter, initialTiled }: {
    sessions: PtySessionInfo[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onKill: (id: string) => void;
    onNewShell: (projectId: string) => void;
    projects: Project[];
    tasksById: Record<string, TaskVM>;
    renames?: Record<string, string>;
    onRename?: (id: string, name: string) => void;
    // Initializers only (renderer state, not persisted) — the static-render tests use them to mount
    // the view at a known filter/tiling state, since the no-jsdom harness can't operate the Selects.
    initialFilter?: { projectId: string | null; taskId: string | null };
    initialTiled?: string[];
}) {
    const [confirmKill, setConfirmKill] = useState<PtySessionInfo | null>(null);
    // uncontrolled fallback so the view stays self-sufficient when App doesn't lift the map
    const [localRenames, setLocalRenames] = useState<Record<string, string>>({});
    const overrides = renames ?? localRenames;
    const rename = (id: string, name: string) =>
        onRename ? onRename(id, name) : setLocalRenames((m) => ({ ...m, [id]: name }));
    const [filterProject, setFilterProject] = useState<string | null>(initialFilter?.projectId ?? null);
    const [filterTask, setFilterTask] = useState<string | null>(initialFilter?.taskId ?? null);
    // Session ids tiled BESIDE the active pane (in-app tiling): each resolves against the current
    // filtered set, so a killed/filtered-out session simply drops out of the split.
    const [tiledIds, setTiledIds] = useState<string[]>(initialTiled ?? []);
    const actions = useContext(ActionCtx);
    const shown = filterSessions(sessions, filterProject, filterTask);
    // Active is resolved WITHIN the filter, so the pane always matches a visible tab.
    const active = shown.find((s) => s.id === activeId) ?? shown.find((s) => s.alive) ?? shown[0];
    // The tiled panes: the active session plus every tiled id that still resolves within the
    // filtered set. Order is active-first, then tab-strip order.
    const panes = active ? [active, ...shown.filter((s) => s.id !== active.id && tiledIds.includes(s.id))] : [];
    const taskOf = active?.taskId ? tasksById[active.taskId] : undefined;
    const liveCount = sessions.filter((s) => s.alive).length;
    const activeLabel = active ? sessionLabel(active, tasksById, overrides) : null;
    // Filter options are computed from the current terminal set, not the project/task catalogs.
    const projectIds = [...new Set(sessions.map((s) => s.projectId).filter((id): id is string => !!id))];
    const taskIds = filterProject
        ? [...new Set(sessions.filter((s) => s.projectId === filterProject).map((s) => s.taskId).filter((id): id is string => !!id))]
        : [];
    return (
        <div className="helm-content helm-fade-in" {...verifyAttrs({
            unit: "TerminalsView", count: sessions.length, live: liveCount, active: active?.id ?? null,
            label: activeLabel, overridden: active ? !!overrides[active.id]?.trim() : null,
            "filter-project": filterProject, "filter-task": filterTask, shown: shown.length, panes: panes.length,
        })} style={{ height: "100%" }}>
            <div style={{ padding: "14px var(--pad-view) 0", background: "var(--surface-app)", borderBottom: "1px solid var(--border-subtle)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, paddingBottom: 12 }}>
                    <h1 style={{ margin: 0, font: "var(--role-title)", letterSpacing: "var(--tracking-tight)" }}>Terminals</h1>
                    <Mono dim size="var(--text-xs)">{liveCount} live</Mono>
                    <Select size="sm" value={filterProject ?? ""} onChange={(e) => { setFilterProject(e.target.value || null); setFilterTask(null); }}
                        options={[{ value: "", label: "All projects" }, ...projectIds.map((id) => ({ value: id, label: projects.find((p) => p.id === id)?.name ?? id }))]} />
                    {filterProject && (
                        <Select size="sm" value={filterTask ?? ""} onChange={(e) => setFilterTask(e.target.value || null)}
                            options={[{ value: "", label: "All tasks" }, ...taskIds.map((id) => ({ value: id, label: tasksById[id]?.title ?? id }))]} />
                    )}
                    <span style={{ flex: 1 }}></span>
                    <Select size="sm" value="" onChange={(e) => { if (e.target.value) { onNewShell(e.target.value); e.currentTarget.value = ""; } }}
                        options={[{ value: "", label: "Open shell in…" }, ...projects.map((p) => ({ value: p.id, label: p.name + " — repo root" }))]} />
                </div>
                <div style={{ display: "flex", gap: 4, overflowX: "auto" }}>
                    {shown.map((s) => {
                        const label = sessionLabel(s, tasksById, overrides);
                        return (
                            <div key={s.id} onClick={() => onSelect(s.id)}
                                // a Helm-side label overlays the pty title, never erases it: whenever the
                                // two differ, the underlying title stays discoverable as the hover tooltip
                                title={label !== s.title ? s.title : undefined}
                                style={{
                                    display: "flex", alignItems: "center", gap: 8, padding: "7px 8px 7px 12px", cursor: "pointer",
                                    borderRadius: "8px 8px 0 0", border: "1px solid var(--border-subtle)", borderBottom: "none",
                                    background: active && s.id === active.id ? "var(--surface-base)" : "transparent",
                                    color: s.alive ? (active && s.id === active.id ? "var(--text-primary)" : "var(--text-secondary)") : "var(--text-faint)",
                                    fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap", userSelect: "none",
                                }}>
                                <Icon name={KIND_ICON[s.kind]} size={13} style={{ color: s.alive ? "var(--amber-400)" : "var(--text-faint)" }} />
                                {label}
                                {!s.alive && <span style={{ color: "var(--text-faint)" }}>· exited</span>}
                                <Tooltip label={s.alive ? "Kill session — closing is killing" : "Remove from list"}>
                                    <IconButton size="sm" label="Kill session" onClick={(e) => { e.stopPropagation(); if (s.alive) setConfirmKill(s); else onKill(s.id); }}>
                                        <Icon name="X" size={12} />
                                    </IconButton>
                                </Tooltip>
                            </div>
                        );
                    })}
                </div>
            </div>

            {active ? (
                <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 10, padding: "var(--pad-view)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <Badge variant="outline">{KIND_LABEL[active.kind]}</Badge>
                        {/* keyed by session + resolved label so an outside change (task rebind, cleared
                            override) re-seeds the field; typing itself only commits on blur/Enter */}
                        <input key={active.id + ":" + activeLabel} aria-label="Rename session" defaultValue={activeLabel ?? ""}
                            onBlur={(e) => rename(active.id, e.currentTarget.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                            style={{
                                font: "var(--role-mono, inherit)", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)",
                                color: "var(--text-primary)", background: "transparent", border: "1px solid transparent",
                                borderRadius: 6, padding: "3px 6px", minWidth: 160, outline: "none",
                            }}
                            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--border-subtle)"; }} />
                        <Mono dim size="var(--text-2xs)">{active.cwd}</Mono>
                        {taskOf && (
                            <a onClick={() => actions.openTask(taskOf.id)} style={{ cursor: "pointer", fontSize: "var(--text-xs)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                                <Icon name="ArrowUpRight" size={12} /> {taskOf.title}
                            </a>
                        )}
                        <span style={{ flex: 1 }}></span>
                        {active.alive && (
                            <Tooltip label="Open this terminal in its own window (close that window to pin it back)">
                                <IconButton size="sm" label="Unpin terminal" onClick={() => void window.helm.terminalUnpin(active.id)}>
                                    <Icon name="Unlink" size={13} />
                                </IconButton>
                            </Tooltip>
                        )}
                        {shown.length > 1 && (
                            <Select size="sm" value={tiledIds.find((id) => panes.some((p) => p.id === id)) ?? ""}
                                onChange={(e) => setTiledIds(e.target.value ? [e.target.value] : [])}
                                options={[{ value: "", label: "No split" },
                                    ...shown.filter((s) => s.id !== active.id).map((s) => ({ value: s.id, label: "Split with " + sessionLabel(s, tasksById, overrides) }))]} />
                        )}
                        <Mono dim size="var(--text-2xs)">hiding this view keeps the session alive — closing kills it</Mono>
                    </div>
                    <div style={{ flex: 1, minHeight: 0 }}>
                        {/* keyed by pane membership: a tab switch or split change remounts the tiling →
                            each pane re-attaches + replays scrollback, and the split resets to even */}
                        <TerminalTiling key={panes.map((p) => p.id).join("+")} sessions={panes}
                            labels={Object.fromEntries(panes.map((p) => [p.id, sessionLabel(p, tasksById, overrides)]))} />
                    </div>
                </div>
            ) : (
                <EmptyState icon="Terminal" line={sessions.length ? "No terminals match the filter." : "No sessions. Open a shell, drop into a task, or start a planner."} />
            )}

            <ConfirmDialog open={!!confirmKill} title="Kill this session?"
                body={confirmKill ? <span>「<Mono>{sessionLabel(confirmKill, tasksById, overrides)}</Mono>」 is a live PTY. Killing it ends the process — switching away or hiding the window would have kept it running.</span> : null}
                confirmLabel="Kill session" danger
                onConfirm={() => confirmKill && onKill(confirmKill.id)} onClose={() => setConfirmKill(null)} />
        </div>
    );
}
