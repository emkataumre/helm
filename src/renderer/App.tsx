// src/renderer/App.tsx
// The cockpit root: route state, the real data plane (window.helm + push events), the
// per-task snapshot cache, the operator actions (the verb list, nothing else), dialogs
// and toasts. Ported from the Claude Design handoff (app/main.jsx) with the simulation
// replaced by the live engine: tasks:changed re-fetches the board, snapshot:changed
// refreshes one task's telemetry, plan:changed feeds the planner rail, pty:exit greys
// terminal tabs. Statuses stay engine-owned — every mutation goes through a HelmApi verb.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
    EngineSnapshot, NewProjectInput, NewTaskInput, Plan, PlanRailState, Project,
    ProjectConfigPatch, PtySession, PtySessionInfo, SchedulerState, TaskListItem,
} from "../shared/types";
import { Toast, type ToastTone } from "./ds";
import { ActionCtx, ConfirmDialog, type CockpitActions, type TaskVM } from "./views/helpers";
import { countTasks, FleetView, ProjectView, Sidebar, StatusBar, Titlebar, type Route } from "./views/shell";
import { TaskDetail } from "./views/TaskDetail";
import { TerminalsView } from "./views/Terminals";
import { NewTaskDialog, PromoteDialog, RegisterProjectDialog } from "./views/dialogs";
import type { BoardLayout } from "./views/Board";

// A plain pwsh shell (no claude) is the default program for a free shell — the human runs
// claude themselves if they want it. Drop-in tabs are built main-side (tasks:dropIn).
const FREE_SHELL_ARGV = ["pwsh.exe", "-NoLogo"];
const DAY_MS = 86_400_000;

let toastSeq = 0;
interface ToastItem { id: number; tone: ToastTone; title: string; msg: ReactNode }

const loadRoute = (): Route => {
    try {
        const r = (JSON.parse(localStorage.getItem("helm-route") ?? "") as Route) || { view: "fleet" };
        // M16: the planner tab became the conductor — migrate a route persisted before the rename.
        if (r.view === "project" && (r as { tab?: string }).tab === "planner") r.tab = "conductor";
        return r;
    } catch { return { view: "fleet" }; }
};
const loadLayout = (): BoardLayout => {
    const l = localStorage.getItem("helm-layout");
    return l === "list" || l === "grid" ? l : "kanban";
};

export function App() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [taskRows, setTaskRows] = useState<TaskListItem[]>([]);
    const [plans, setPlans] = useState<Plan[]>([]);
    const [sched, setSched] = useState<SchedulerState | null>(null);
    const [snaps, setSnaps] = useState<Record<string, EngineSnapshot | null>>({});
    const snapsRef = useRef(snaps);
    snapsRef.current = snaps;
    const [validating, setValidating] = useState<Set<string>>(new Set());
    const [sessions, setSessions] = useState<PtySessionInfo[]>([]);
    const [dismissedSessions, setDismissedSessions] = useState<Set<string>>(new Set());
    const [activeSession, setActiveSession] = useState<string | null>(null);
    // Helm-side display names for sessions (manual renames). Lives here so a rename survives
    // leaving the Terminals view; keyed by session id — the id itself is never renamed.
    const [sessionRenames, setSessionRenames] = useState<Record<string, string>>({});
    const [conductorSessions, setConductorSessions] = useState<Record<string, PtySession>>({});
    const [conductorResumable, setConductorResumable] = useState<Record<string, boolean>>({});
    const [railStates, setRailStates] = useState<Record<string, PlanRailState>>({});
    const [route, setRoute] = useState<Route>(loadRoute);
    const [layout, setLayout] = useState<BoardLayout>(loadLayout);
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const [dialogs, setDialogs] = useState<{ newTask: boolean; newTaskProject: string | null; promote: string | null; register: boolean }>({ newTask: false, newTaskProject: null, promote: null, register: false });
    const [confirm, setConfirm] = useState<{ title: string; body: ReactNode; label: string; run: () => void } | null>(null);

    /* ---------- toasts ---------- */
    const toast = useCallback((tone: ToastTone, title: string, msg: ReactNode) => {
        const id = ++toastSeq;
        setToasts((ts) => [...ts.slice(-3), { id, tone, title, msg }]);
        setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 6000);
    }, []);

    /* ---------- routing ---------- */
    const go = useCallback((r: Route) => {
        setRoute(r);
        try { localStorage.setItem("helm-route", JSON.stringify(r)); } catch { /* storage unavailable */ }
    }, []);
    const setBoardLayout = useCallback((l: BoardLayout) => {
        setLayout(l);
        try { localStorage.setItem("helm-layout", l); } catch { /* storage unavailable */ }
    }, []);

    /* ---------- the data plane ---------- */
    // Refetch a task's snapshot when it's missing or its status moved (any transition re-reads;
    // live running detail is additionally push-refreshed via snapshot:changed).
    const hydrateSnaps = useCallback(async (rows: TaskListItem[]) => {
        const targets = rows.filter((t) => {
            const s = snapsRef.current[t.id];
            return !s || s.status !== t.status;
        });
        if (!targets.length) return;
        const entries = await Promise.all(targets.map(async (t) => [t.id, await window.helm.getVerifyState(t.id)] as const));
        setSnaps((m) => { const n = { ...m }; for (const [id, s] of entries) n[id] = s; return n; });
    }, []);

    const refresh = useCallback(async () => {
        const ps = await window.helm.listProjects();
        const rows = await window.helm.listTasks();
        setProjects(ps);
        setTaskRows(rows);
        const perProject = await Promise.all(ps.map((p) => window.helm.listPlans(p.id)));
        setPlans(perProject.flat());
        // A verify-&-merge settled when its task left handed-off.
        setValidating((v) => {
            const still = new Set([...v].filter((id) => rows.find((t) => t.id === id)?.status === "handed-off"));
            return still.size === v.size ? v : still;
        });
        void hydrateSnaps(rows);
    }, [hydrateSnaps]);

    const refreshSched = useCallback(async () => { setSched(await window.helm.getSchedulerState()); }, []);
    const refreshSessions = useCallback(async () => { setSessions(await window.helm.ptyList()); }, []);

    useEffect(() => {
        void refresh(); void refreshSched(); void refreshSessions();
        window.helm.onTasksChanged(() => { void refresh(); void refreshSched(); });
        window.helm.onSnapshotChanged((taskId) => {
            void window.helm.getVerifyState(taskId).then((s) => setSnaps((m) => ({ ...m, [taskId]: s })));
        });
        window.helm.onPlanChanged((projectId, state) => setRailStates((m) => ({ ...m, [projectId]: state })));
        const unsubExit = window.helm.onPtyExit(() => { void refreshSessions(); });
        const id = setInterval(() => { void refreshSched(); }, 1000); // keep the per-project slot counts live
        return () => { clearInterval(id); unsubExit(); };
    }, [refresh, refreshSched, refreshSessions]);

    /* ---------- view models ---------- */
    const tasks: TaskVM[] = useMemo(
        () => taskRows.map((t) => ({ ...t, snap: snaps[t.id] ?? null, validating: validating.has(t.id) })),
        [taskRows, snaps, validating],
    );
    const tasksById = useMemo(() => Object.fromEntries(tasks.map((t) => [t.id, t])), [tasks]);
    const counts = countTasks(tasks);
    const paused = sched?.paused ?? false;
    const visibleSessions = useMemo(() => sessions.filter((s) => !dismissedSessions.has(s.id)), [sessions, dismissedSessions]);

    /* ---------- scheduler pause ---------- */
    const togglePause = useCallback(() => {
        const next = !(sched?.paused ?? false);
        void window.helm.setSchedulerPaused(next).then(refreshSched);
        toast(next ? "warning" : "info", next ? "Scheduler paused" : "Scheduler resumed",
            next ? "Nothing will auto-start. Manual Start-now still works, respecting all gates." : "Free slots refill FIFO, honoring dependency blocks.");
    }, [sched, refreshSched, toast]);

    /* ---------- terminals ---------- */
    const showSession = useCallback((s: PtySession) => {
        setDismissedSessions((d) => { const n = new Set(d); n.delete(s.id); return n; });
        void refreshSessions();
        setActiveSession(s.id);
        go({ view: "terminals" });
    }, [go, refreshSessions]);
    const killSession = useCallback((id: string) => {
        const s = sessions.find((x) => x.id === id);
        if (s && !s.alive) setDismissedSessions((d) => new Set(d).add(id)); // dead → just remove from the list
        else void window.helm.ptyKill(id).then(refreshSessions);           // live → closing IS killing (§8.5)
    }, [sessions, refreshSessions]);
    const newShell = useCallback((projectId: string) => {
        const p = projects.find((x) => x.id === projectId);
        if (!p) return;
        void window.helm.ptyCreate({ cwd: p.repoPath, argv: FREE_SHELL_ARGV, kind: "free", title: `${p.name} — shell`, projectId: p.id }).then(showSession);
    }, [projects, showSession]);

    /* ---------- conductor (the planner absorbed, M16) ---------- */
    // Read-only hydration on tab mount: a still-alive session, the rail state, the resume-guard verdict.
    const hydrateConductor = useCallback((project: Project) => {
        void window.helm.openConductor(project.id).then((r) => {
            if (!r) return;
            setRailStates((m) => ({ ...m, [project.id]: r.state }));
            setConductorResumable((m) => ({ ...m, [project.id]: r.resumable }));
            if (r.session) setConductorSessions((m) => ({ ...m, [project.id]: r.session! }));
        });
    }, []);
    // The explicit launch click (Resume iff the guard holds — main re-checks; Fresh always works).
    const launchConductor = useCallback((project: Project, fresh: boolean) => {
        void window.helm.launchConductor(project.id, fresh).then((s) => {
            if (!s) return;
            setConductorSessions((m) => ({ ...m, [project.id]: s }));
            void refreshSessions(); // the conductor PTY also shows in the Terminals list
        });
    }, [refreshSessions]);
    // The always-on in-pane restart (issue #1): main kills the dead-inside pwsh and respawns. Swap in the new
    // session at once, then re-hydrate so `resumable` reflects the guard again (a Fresh restart forces a new
    // unpersisted id → not resumable until it lands a turn; a Resume restart keeps the recorded id resumable).
    const restartConductor = useCallback((project: Project, fresh: boolean) => {
        void window.helm.restartConductor(project.id, fresh).then((s) => {
            if (!s) return;
            setConductorSessions((m) => ({ ...m, [project.id]: s }));
            hydrateConductor(project);
            void refreshSessions();
        });
    }, [hydrateConductor, refreshSessions]);
    const onPlanApproved = useCallback((projectId: string, count: number, warnings: string[], skipped: boolean) => {
        toast("success", `Queued ${count} task${count === 1 ? "" : "s"}`,
            (warnings.length ? warnings.join(" · ") + ". " : "PRD stored durably with the plan. ") +
            (skipped ? "Pre-flight was explicitly skipped." : "Every warning was acknowledged."));
        go({ view: "project", projectId, tab: "board" });
        void refresh();
    }, [toast, go, refresh]);

    /* ---------- operator actions (the verb list, nothing else) ---------- */
    const grab = async (t: TaskVM, fresh: boolean) => {
        const proj = projects.find((p) => p.id === t.projectId);
        const wasRunning = t.status === "running";
        const s = await window.helm.dropIn(t.id, fresh); // running → hard-interrupt + handed-off
        void refresh();
        if (s) {
            showSession(s);
            if (wasRunning) toast("warning", "Agent interrupted", "Partial work was checkpoint-committed. The task is handed-off — you are at the helm.");
        } else if (proj?.terminalCommand) {
            toast("info", "External terminal launched", proj.terminalCommand.replace("{worktree}", t.worktreePath ?? "").replace("{resume}", fresh ? "" : "--resume <session>"));
        }
    };

    const actions: CockpitActions = {
        openTask: (id) => go({ view: "task", taskId: id }),
        openPlan: (projectId, planId) => go({ view: "project", projectId, tab: "plans", planId }),
        startNow: (t) => {
            // Pre-check the same gates the scheduler applies, so a silent engine no-op becomes feedback.
            const proj = projects.find((p) => p.id === t.projectId);
            if (t.status !== "queued") return toast("warning", "Not queued", "Only queued tasks can be started.");
            if (t.blocked) return toast("warning", "Dependency-blocked", "Waiting on: " + t.waitingOn.map((w) => w.title).join(", "));
            const slot = sched?.perProject.find((r) => r.projectId === t.projectId);
            const running = slot?.running ?? tasks.filter((x) => x.projectId === t.projectId && x.status === "running").length;
            const cap = slot?.cap ?? proj?.concurrencyCap ?? 3;
            if (running >= cap) return toast("warning", "No free slot", `${proj?.name ?? t.projectId} is at ${running}/${cap} concurrent tasks.`);
            void window.helm.startNow(t.id).then(refresh);
            toast("success", "Started", t.title);
        },
        dropIn: (t) => {
            if (!t.resumable) return toast("warning", "Nothing to resume", "No persisted session — use Start fresh.");
            void grab(t, false);
        },
        startFresh: (t) => { void grab(t, true); },
        resume: (t) => {
            void window.helm.resumeTask(t.id).then(refresh);
            toast("success", "Handed back to the loop", "Worktree and history kept. Fresh iteration and cost budget. " + (paused ? "Queued — the scheduler is paused." : "It re-queues and starts when a slot frees."));
        },
        verifyMerge: (t) => {
            setValidating((v) => new Set(v).add(t.id));
            void window.helm.verifyAndMerge(t.id);
            toast("info", "Verify & merge running", "Committing your work, then full merge-stage validation against the fresh integration tip. The task stays handed-off while it validates.");
        },
        abandon: (t) => setConfirm({
            title: `Abandon ${t.title.length > 32 ? t.title.slice(0, 32) + "…" : t.title}?`,
            body: "The worktree and branch are reaped and the task is marked abandoned — terminal, but it stays viewable as history.",
            label: "Abandon task",
            run: () => {
                void window.helm.abandon(t.id).then(refresh);
                toast("info", "Abandoned", t.title);
            },
        }),
        clearDeps: (t) => setConfirm({
            title: "Clear dependencies?",
            body: "The escape hatch for a stuck task: its dependency set is replaced with none. It may immediately unblock and auto-start.",
            label: "Clear dependencies",
            run: () => {
                void window.helm.setDependsOn(t.id, []).then(refresh);
                toast("success", "Dependencies cleared", t.title + (paused ? " — still queued (scheduler paused)." : " — it will auto-start when a slot frees."));
            },
        }),
        openShell: (t) => {
            if (!t.worktreePath) return;
            void window.helm.ptyCreate({ cwd: t.worktreePath, argv: FREE_SHELL_ARGV, kind: "free", title: `${t.title.slice(0, 22)} — shell`, taskId: t.id, projectId: t.projectId }).then(showSession);
        },
    };

    /* ---------- dialog ops ---------- */
    const createTask = (input: NewTaskInput) => {
        void window.helm.createTask(input).then(() => void refresh());
        toast("success", "Task queued", input.title + (paused ? " — the scheduler is paused; use Start now or resume auto-start." : " — auto-starts when a slot frees."));
    };
    const registerProject = (input: NewProjectInput) => {
        void window.helm.registerProject(input).then((p) => {
            toast("success", "Project registered", `${p.name} — its board is empty. Queue a task or open the planner.`);
            go({ view: "project", projectId: p.id, tab: "board" });
            void refresh();
        });
    };
    const saveConfig = (id: string, patch: ProjectConfigPatch) => {
        void window.helm.updateProject(id, patch).then((p) => {
            toast("success", "Config saved", (p?.name ?? id) + " — freed slots fill immediately if you raised concurrency.");
            void refresh();
        });
    };
    const deleteProject = (id: string) => {
        const p = projects.find((x) => x.id === id);
        void window.helm.deleteProject(id).then(() => {
            toast("info", "Project deleted", `${p?.name ?? id} and all its tasks, iterations and plans are gone.`);
            go({ view: "fleet" });
            void refresh();
        });
    };

    /* ---------- keyboard (design: N new task · P pause toggle) ---------- */
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement | null)?.tagName ?? "";
            if (/input|textarea|select/i.test(tag)) return;
            if (e.key === "n" || e.key === "N") setDialogs((d) => ({ ...d, newTask: true, newTaskProject: route.view === "project" ? route.projectId : null }));
            if (e.key === "p" || e.key === "P") togglePause();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [route, togglePause]);

    /* ---------- routed view ---------- */
    const routeProject = route.view === "project" ? projects.find((p) => p.id === route.projectId) : undefined;
    const routeTask = route.view === "task" ? tasksById[route.taskId] : undefined;
    const fleetFallback = (route.view === "project" && !routeProject) || (route.view === "task" && !routeTask);

    return (
        <ActionCtx.Provider value={actions}>
            <div className="helm-root">
                <Titlebar counts={counts} paused={paused} onTogglePause={togglePause} />
                <div className="helm-main">
                    <Sidebar projects={projects} tasks={tasks} sessions={visibleSessions} route={route} go={go} paused={paused}
                        onRegister={() => setDialogs((d) => ({ ...d, register: true }))} />
                    {(route.view === "fleet" || fleetFallback) && (
                        <FleetView tasks={tasks} projects={projects} layout={layout} onLayout={setBoardLayout}
                            onNewTask={() => setDialogs((d) => ({ ...d, newTask: true, newTaskProject: null }))} />
                    )}
                    {route.view === "project" && routeProject && (
                        <ProjectView
                            project={routeProject} tasks={tasks} plans={plans} layout={layout} onLayout={setBoardLayout}
                            route={route} go={go}
                            conductorSession={conductorSessions[routeProject.id] ?? null}
                            conductorRail={railStates[routeProject.id]}
                            conductorResumable={conductorResumable[routeProject.id] ?? false}
                            onHydrateConductor={() => hydrateConductor(routeProject)}
                            onLaunchConductor={(fresh) => launchConductor(routeProject, fresh)}
                            onRestartConductor={(fresh) => restartConductor(routeProject, fresh)}
                            onApproved={(count, warnings, skipped) => onPlanApproved(routeProject.id, count, warnings, skipped)}
                            onNewTask={() => setDialogs((d) => ({ ...d, newTask: true, newTaskProject: routeProject.id }))}
                            onPromote={() => setDialogs((d) => ({ ...d, promote: routeProject.id }))}
                            onSaveConfig={saveConfig} onDeleteProject={deleteProject}
                        />
                    )}
                    {route.view === "task" && routeTask && (
                        <TaskDetail
                            task={routeTask} project={projects.find((p) => p.id === routeTask.projectId)!}
                            tasksById={tasksById} plans={plans}
                            onBack={() => go({ view: "project", projectId: routeTask.projectId, tab: "board" })}
                        />
                    )}
                    {route.view === "terminals" && (
                        <TerminalsView sessions={visibleSessions} activeId={activeSession}
                            onSelect={setActiveSession} onKill={killSession} onNewShell={newShell}
                            projects={projects} tasksById={tasksById} renames={sessionRenames}
                            onRename={(id, name) => setSessionRenames((m) => ({ ...m, [id]: name }))} />
                    )}
                </div>
                <StatusBar counts={counts} projects={projects} sched={sched} paused={paused} />

                {/* dialogs */}
                <NewTaskDialog open={dialogs.newTask} projects={projects} tasks={tasks} defaultProjectId={dialogs.newTaskProject}
                    onCreate={createTask} onClose={() => setDialogs((d) => ({ ...d, newTask: false }))} />
                <PromoteDialog open={!!dialogs.promote} project={projects.find((p) => p.id === dialogs.promote)}
                    onClose={() => setDialogs((d) => ({ ...d, promote: null }))} />
                <RegisterProjectDialog open={dialogs.register} onCreate={registerProject} onClose={() => setDialogs((d) => ({ ...d, register: false }))} />
                <ConfirmDialog open={!!confirm} title={confirm?.title ?? ""} body={confirm?.body} confirmLabel={confirm?.label ?? "Confirm"} danger
                    onConfirm={() => confirm?.run()} onClose={() => setConfirm(null)} />

                {/* toasts */}
                <div className="helm-toasts">
                    {toasts.map((x) => (
                        <Toast key={x.id} tone={x.tone} title={x.title} onClose={() => setToasts((ts) => ts.filter((y) => y.id !== x.id))}>{x.msg}</Toast>
                    ))}
                </div>
            </div>
        </ActionCtx.Provider>
    );
}
