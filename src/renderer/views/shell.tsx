// src/renderer/views/shell.tsx
// App chrome: titlebar (drag region + fleet counts + the pause switch; Electron overlays
// the native window controls), sidebar (Fleet / Terminals / projects nav), status bar
// (telemetry strip mirroring the tray tooltip), and the Fleet / Project views.
// Ported from the design handoff (app/shell.jsx) onto the real data plane.
import { useEffect, useState } from "react";
import type { Plan, PlanRailState, Project, ProjectConfigPatch, PtySession, PtySessionInfo, SchedulerState } from "../../shared/types";
import mark from "../assets/helm-mark.svg";
import { Badge, Button, Icon, Kbd, StatusDot, Switch, Tabs, Tooltip } from "../ds";
import { verifyAttrs } from "../components/verifyAttrs";
import { Board, LayoutSwitch, type BoardLayout } from "./Board";
import { ConductorTab } from "./Conductor";
import { PlansTab } from "./Plans";
import { ProjectConfigTab } from "./dialogs";
import { ActivityPanel, Mono, Overline, type TaskVM } from "./helpers";

export interface FleetCounts { running: number; needsHuman: number; merged: number }
export const countTasks = (tasks: TaskVM[]): FleetCounts => ({
    running: tasks.filter((t) => t.status === "running").length,
    needsHuman: tasks.filter((t) => t.status === "needs-human").length,
    merged: tasks.filter((t) => t.status === "merged").length,
});

export type Route =
    | { view: "fleet" }
    | { view: "terminals" }
    | { view: "project"; projectId: string; tab?: "board" | "conductor" | "plans" | "config"; planId?: string }
    | { view: "task"; taskId: string };

/* ================= titlebar ================= */
export function Titlebar({ counts, paused, onTogglePause }: { counts: FleetCounts; paused: boolean; onTogglePause: () => void }) {
    return (
        <div className="helm-titlebar" {...verifyAttrs({ unit: "Titlebar", running: counts.running, "needs-human": counts.needsHuman, merged: counts.merged, paused })}>
            <img src={mark} alt="" width={18} height={18} draggable={false} />
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 500, fontSize: 15, letterSpacing: "-0.015em" }}>Helm</span>
            <Mono dim size="var(--text-2xs)" style={{ marginLeft: 4 }}>
                {counts.running} running · {counts.needsHuman} needs-human · {counts.merged} merged
            </Mono>
            <span style={{ flex: 1 }}></span>
            <Tooltip label={<span>Auto-start toggle · <Kbd keys={["P"]} /></span>} side="bottom">
                <span className="helm-no-drag" style={{ display: "inline-flex", alignItems: "center", gap: 8, marginRight: 6 }}>
                    {paused && <Badge variant="amber"><Icon name="Pause" size={10} style={{ display: "inline-block", marginRight: 4, verticalAlign: -1 }} />paused</Badge>}
                    <Switch checked={!paused} onChange={onTogglePause} label={<Mono dim size="var(--text-2xs)">{paused ? "scheduler paused" : "auto-start on"}</Mono>} />
                </span>
            </Tooltip>
        </div>
    );
}

/* ================= sidebar ================= */
export function Sidebar({ projects, tasks, sessions, route, go, onRegister, paused }: {
    projects: Project[];
    tasks: TaskVM[];
    sessions: PtySessionInfo[];
    route: Route;
    go: (r: Route) => void;
    onRegister: () => void;
    paused: boolean;
}) {
    const perProject = (pid: string) => {
        const pt = tasks.filter((t) => t.projectId === pid);
        return {
            running: pt.filter((t) => t.status === "running").length,
            nh: pt.filter((t) => t.status === "needs-human").length,
        };
    };
    const liveSessions = sessions.filter((s) => s.alive).length;
    return (
        <div className="helm-sidebar" {...verifyAttrs({ unit: "Sidebar", projects: projects.length, live: liveSessions })}>
            <div style={{ padding: "14px 8px 6px", display: "flex", flexDirection: "column", gap: 2 }}>
                <div className={"helm-nav-item" + (route.view === "fleet" ? " active" : "")} onClick={() => go({ view: "fleet" })}>
                    <Icon name="LayoutGrid" size={15} /> <span style={{ flex: 1 }}>Fleet</span>
                    <Mono dim size="var(--text-2xs)">{tasks.length}</Mono>
                </div>
                <div className={"helm-nav-item" + (route.view === "terminals" ? " active" : "")} onClick={() => go({ view: "terminals" })}>
                    <Icon name="Terminal" size={15} /> <span style={{ flex: 1 }}>Terminals</span>
                    {liveSessions > 0 && <Mono size="var(--text-2xs)" style={{ color: "var(--amber-400)" }}>{liveSessions} live</Mono>}
                </div>
            </div>

            <div style={{ padding: "12px 18px 6px" }}>
                <Overline>projects</Overline>
            </div>
            <div className="helm-scroll" style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, paddingBottom: 8 }}>
                {projects.map((p) => {
                    const c = perProject(p.id);
                    const active = route.view === "project" && route.projectId === p.id;
                    return (
                        <div key={p.id} className={"helm-nav-item" + (active ? " active" : "")} onClick={() => go({ view: "project", projectId: p.id, tab: "board" })}>
                            <Icon name={p.jailImage ? "Container" : "FolderGit2"} size={15} />
                            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>{p.name}</span>
                            {c.nh > 0
                                ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><StatusDot status="needs-human" size={6} /><Mono size="var(--text-2xs)" style={{ color: "var(--amber-400)" }}>{c.nh}</Mono></span>
                                : c.running > 0
                                    ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><StatusDot status="running" size={6} pulse /><Mono dim size="var(--text-2xs)">{c.running}</Mono></span>
                                    : null}
                        </div>
                    );
                })}
            </div>

            <div style={{ padding: 12, borderTop: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 10 }}>
                {paused && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--amber-300)" }}>
                        <Icon name="Pause" size={12} /> paused — nothing will auto-start
                    </div>
                )}
                <Button variant="outline" size="sm" fullWidth iconLeft={<Icon name="Plus" size={13} />} onClick={onRegister}>Register project</Button>
            </div>
        </div>
    );
}

/* ================= status bar ================= */
export function StatusBar({ counts, projects, sched, paused }: {
    counts: FleetCounts;
    projects: Project[];
    sched: SchedulerState | null;
    paused: boolean;
}) {
    const names = Object.fromEntries(projects.map((p) => [p.id, p.name]));
    const slotLine = (sched?.perProject ?? [])
        .map((r) => `${names[r.projectId] ?? r.projectId} ${r.running}/${r.cap}`)
        .join(" · ");
    // The M4 scheduler invariant, machine-readable: no project ever runs past its cap.
    const withinCap = (sched?.perProject ?? []).every((r) => r.running <= r.cap);
    return (
        <div className="helm-statusbar" {...verifyAttrs({ unit: "StatusBar", paused, running: counts.running, "needs-human": counts.needsHuman, merged: counts.merged, "within-cap": withinCap })}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {paused
                    ? <span style={{ color: "var(--amber-400)", display: "inline-flex", alignItems: "center", gap: 5 }}><Icon name="Pause" size={11} /> scheduler paused</span>
                    : <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><StatusDot status="running" size={6} pulse={counts.running > 0} /> {counts.running} running</span>}
            </span>
            <span style={{ color: counts.needsHuman > 0 ? "var(--amber-400)" : "var(--text-faint)" }}>{counts.needsHuman} needs-human</span>
            <span>{counts.merged} merged</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{slotLine}</span>
            <span style={{ flex: 1 }}></span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--text-faint)" }}>
                <Icon name="Anchor" size={11} /> tray: Helm — {counts.running} running · {counts.needsHuman} needs-human · {counts.merged} merged
            </span>
        </div>
    );
}

/* ================= fleet view ================= */
export function FleetView({ tasks, projects, layout, onLayout, onNewTask }: {
    tasks: TaskVM[];
    projects: Project[];
    layout: BoardLayout;
    onLayout: (l: BoardLayout) => void;
    onNewTask: () => void;
}) {
    return (
        <div className="helm-content helm-fade-in" {...verifyAttrs({ unit: "FleetView", tasks: tasks.length })} style={{ overflowY: "auto" }}>
            <div style={{ padding: "var(--pad-view)", display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <h1 style={{ margin: 0, font: "var(--role-title)", letterSpacing: "var(--tracking-tight)" }}>Fleet</h1>
                    <Mono dim>{tasks.length} tasks · {projects.length} projects</Mono>
                    <span style={{ flex: 1 }}></span>
                    <LayoutSwitch layout={layout} onChange={onLayout} />
                    <Tooltip label={<span>New task <Kbd keys={["N"]} /></span>}>
                        <Button variant="primary" iconLeft={<Icon name="Plus" size={14} />} onClick={onNewTask}>New task</Button>
                    </Tooltip>
                </div>
                <Board tasks={tasks} projects={projects} layout={layout} showProject
                    emptyAction={<Button variant="primary" size="sm" onClick={onNewTask}>New task</Button>} />
            </div>
        </div>
    );
}

/* ================= project view ================= */
export function ProjectView({ project, tasks, plans, layout, onLayout, route, go, conductorSession, conductorRail, conductorResumable, onHydrateConductor, onLaunchConductor, onRestartConductor, onApproved, onNewTask, onPromote, onSaveConfig, onDeleteProject }: {
    project: Project;
    tasks: TaskVM[]; // the whole fleet — filtered per tab below
    plans: Plan[];
    layout: BoardLayout;
    onLayout: (l: BoardLayout) => void;
    route: Extract<Route, { view: "project" }>;
    go: (r: Route) => void;
    conductorSession: PtySession | null;
    conductorRail: PlanRailState | undefined;
    conductorResumable: boolean;
    onHydrateConductor: () => void;
    onLaunchConductor: (fresh: boolean) => void;
    onRestartConductor: (fresh: boolean) => void;
    onApproved: (count: number, warnings: string[], skipped: boolean) => void;
    onNewTask: () => void;
    onPromote: () => void;
    onSaveConfig: (id: string, patch: ProjectConfigPatch) => void;
    onDeleteProject: (id: string) => void;
}) {
    const tab = route.tab ?? "board";
    const [planFilter, setPlanFilter] = useState<string | null>(null);
    const myTasks = tasks.filter((t) => t.projectId === project.id);
    const myPlans = plans.filter((p) => p.projectId === project.id);
    const mergedAt = myTasks.filter((t) => t.status === "merged").map((t) => t.updatedAt);
    useEffect(() => { setPlanFilter(null); }, [project.id]);
    return (
        <div className="helm-content helm-fade-in" {...verifyAttrs({ unit: "ProjectView", id: project.id, tab, jail: project.jailImage ? true : null })} style={{ overflowY: "auto" }}>
            <div style={{ padding: "var(--pad-view)", paddingBottom: 0, display: "flex", flexDirection: "column", gap: 14, flex: 1, minHeight: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <h1 style={{ margin: 0, font: "var(--role-title)", letterSpacing: "var(--tracking-tight)", fontFamily: "var(--font-mono)" }}>{project.name}</h1>
                    {project.jailImage && <Tooltip label={"agents run jailed in " + project.jailImage}><Badge variant="info"><Icon name="Container" size={11} style={{ display: "inline-block", marginRight: 4, verticalAlign: -1 }} />jailed</Badge></Tooltip>}
                    <Mono dim size="var(--text-2xs)">{project.repoPath} · {project.targetBranch}</Mono>
                    <span style={{ flex: 1 }}></span>
                    <Button variant="secondary" iconLeft={<Icon name="GitCompare" size={14} />} onClick={onPromote}>Promote</Button>
                    <Button variant="primary" iconLeft={<Icon name="Plus" size={14} />} onClick={onNewTask}>New task</Button>
                </div>

                <Tabs value={tab} onChange={(id) => go({ view: "project", projectId: project.id, tab: id as "board" | "conductor" | "plans" | "config" })} items={[
                    { id: "board", label: "Board", icon: <Icon name="LayoutGrid" size={14} />, count: myTasks.length || undefined },
                    { id: "conductor", label: "Conductor", icon: <Icon name="Anchor" size={14} /> },
                    { id: "plans", label: "Plans", icon: <Icon name="ScrollText" size={14} />, count: myPlans.length || undefined },
                    { id: "config", label: "Config", icon: <Icon name="Settings2" size={14} /> },
                ]} />

                <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", paddingBottom: "var(--pad-view)" }}>
                    {tab === "board" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                            <details style={{ border: "1px solid var(--border-subtle)", borderRadius: 10, background: "var(--surface-card)", boxShadow: "var(--elev-card)" }}>
                                <summary style={{ padding: "9px 12px", cursor: "pointer", fontSize: "var(--text-xs)", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--font-mono)" }}>
                                    <Icon name="CalendarRange" size={13} style={{ display: "inline-block" }} /> activity — {mergedAt.length} merged all-time
                                </summary>
                                <div style={{ padding: "4px 12px 14px" }}><ActivityPanel tasks={myTasks} /></div>
                            </details>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                {planFilter && (
                                    <>
                                        <Badge variant="amber">plan: {myPlans.find((p) => p.id === planFilter)?.title ?? planFilter}</Badge>
                                        <Button size="sm" variant="ghost" onClick={() => setPlanFilter(null)}>Clear filter</Button>
                                    </>
                                )}
                                <span style={{ flex: 1 }}></span>
                                <LayoutSwitch layout={layout} onChange={onLayout} />
                            </div>
                            <Board tasks={myTasks} projects={[project]} layout={layout} planFilter={planFilter}
                                emptyAction={<Button variant="primary" size="sm" onClick={onNewTask}>New task</Button>} />
                        </div>
                    )}
                    {tab === "conductor" && (
                        <ConductorTab project={project} session={conductorSession} rail={conductorRail} resumable={conductorResumable}
                            onHydrate={onHydrateConductor} onLaunch={onLaunchConductor} onRestart={onRestartConductor} onApproved={onApproved} />
                    )}
                    {tab === "plans" && (
                        <PlansTab project={project} plans={plans} tasks={tasks} initialPlanId={route.planId ?? null}
                            onFilterBoard={(pid) => { setPlanFilter(pid); go({ view: "project", projectId: project.id, tab: "board" }); }} />
                    )}
                    {tab === "config" && <ProjectConfigTab project={project} onSave={onSaveConfig} onDelete={onDeleteProject} />}
                </div>
            </div>
        </div>
    );
}
