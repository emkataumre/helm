// src/renderer/views/Board.tsx
// The fleet board: kanban / list / grid layouts + status filter chips. Ported from the
// Claude Design handoff (app/board.jsx); data comes from TaskVM (TaskListItem + live
// snapshot), verbs from the shared VerbBar. Statuses are engine-owned — cards never move
// by hand; the layouts are pure projections of task.status.
import { useContext, useState } from "react";
import type { ReactNode } from "react";
import type { Project, TaskStatus } from "../../shared/types";
import { Icon, ProgressBar, StatusDot } from "../ds";
import { verifyAttrs } from "../components/verifyAttrs";
import {
    ActionCtx, EmptyState, FailureBox, MergeChip, Mono, StatusChip, VerbBar, WaitingOn,
    fmtDiffstat, fmtUsd, mergePhaseOf, parseDiffstat, stuckOf, timeAgo, type TaskVM,
} from "./helpers";

export type BoardLayout = "kanban" | "list" | "grid";

const STATUS_ORDER: TaskStatus[] = ["needs-human", "running", "handed-off", "queued", "merged", "abandoned"];
const KANBAN_COLS: Array<{ id: string; label: string; statuses: TaskStatus[] }> = [
    { id: "queued", label: "queued", statuses: ["queued"] },
    { id: "running", label: "running", statuses: ["running"] },
    { id: "needs-human", label: "needs-human", statuses: ["needs-human"] },
    { id: "handed-off", label: "handed-off", statuses: ["handed-off"] },
    { id: "done", label: "done", statuses: ["merged", "abandoned"] },
];

export function sortTasks(tasks: TaskVM[]): TaskVM[] {
    return [...tasks].sort((a, b) => {
        const sa = STATUS_ORDER.indexOf(a.status), sb = STATUS_ORDER.indexOf(b.status);
        if (sa !== sb) return sa - sb;
        return b.updatedAt - a.updatedAt;
    });
}

const capOf = (p: Project | undefined) => p?.iterationCap ?? 8;
// The human-facing attempt count: the in-flight iteration's 1-based ordinal, else attempts so far.
const attemptOf = (t: TaskVM) => (t.snap?.currentIteration ? t.snap.currentIteration.index + 1 : t.snap?.iterations.length ?? 0);

/* ---------- shared card body bits ---------- */
function CardMetaLine({ task, project, showProject }: { task: TaskVM; project?: Project; showProject?: boolean }) {
    const bits: string[] = [];
    if (showProject && project) bits.push(project.name + (project.jailImage ? " · jail" : ""));
    else if (project?.jailImage) bits.push("jail");
    const idx = attemptOf(task);
    if (idx > 0) bits.push(`it ${idx}/${capOf(project)}`);
    const cost = task.snap?.totals.costUsd ?? 0;
    if (cost > 0) bits.push(fmtUsd(cost));
    if (task.diffstat) {
        const d = parseDiffstat(task.diffstat);
        bits.push(d ? `+${d.plus} −${d.minus}` : task.diffstat);
    }
    if (!bits.length) bits.push(timeAgo(task.createdAt));
    return <Mono dim size="var(--text-2xs)" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{bits.join(" · ")}</Mono>;
}

/* ---------- task card (kanban + grid) ---------- */
export function TaskCard({ task, project, showProject }: { task: TaskVM; project?: Project; showProject?: boolean }) {
    const actions = useContext(ActionCtx);
    const terminal = task.status === "merged" || task.status === "abandoned";
    const cur = task.snap?.currentIteration ?? null;
    const mergePhase = mergePhaseOf(task);
    const verbs = !terminal;
    return (
        <div
            className="helm-task-card"
            {...verifyAttrs({
                unit: "TaskCard", status: task.status, id: task.id,
                resumable: task.resumable, blocked: task.blocked, stuck: stuckOf(task),
                "merge-phase": mergePhase,
                "waiting-on": task.blocked ? task.waitingOn.map((w) => w.title).join(", ") || null : null,
                plan: task.planId, jail: project?.jailImage ? true : null,
            })}
            style={{ opacity: task.status === "abandoned" ? 0.55 : 1 }}
            onClick={() => actions.openTask(task.id)}
        >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <span style={{ fontSize: "var(--text-md)", fontWeight: 500, lineHeight: 1.3, flex: 1, minWidth: 0 }}>{task.title}</span>
                <StatusChip status={task.blocked ? "blocked" : task.status} />
            </div>
            <CardMetaLine task={task} project={project} showProject={showProject} />

            {task.status === "running" && cur && (
                <>
                    <div className="helm-activity">
                        {cur.latestActivity || "…"}<span className="helm-live-caret"></span>
                    </div>
                    <ProgressBar value={cur.index + 1} max={capOf(project)} tone="running" size="sm" />
                </>
            )}
            {/* The merge stage runs after the last iteration ends (currentIteration is null), so
                without this a landing task reads like a plain idle running one. */}
            {mergePhase && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <MergeChip phase={mergePhase} />
                    <div style={{ flex: 1 }}><ProgressBar indeterminate size="sm" tone="primary" /></div>
                </div>
            )}

            {task.status === "needs-human" && <FailureBox reason={task.failureReason} quiet />}
            {task.validating && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: 1 }}><ProgressBar indeterminate size="sm" tone="primary" /></div>
                    <Mono dim size="var(--text-2xs)">validating…</Mono>
                </div>
            )}
            {task.blocked && <WaitingOn task={task} />}

            {verbs && <div className="helm-card-verbs"><VerbBar task={task} compact /></div>}
        </div>
    );
}

/* ---------- kanban ---------- */
// The live pipeline is four columns; the terminal merged/abandoned pile grows without
// bound, so it lives in a *foldable* strip below the board (collapsed by default). It's
// there when you want it, and dropping it from the column row keeps 4 columns inside a
// laptop width — no page-wide side-scroll. Opened, it previews a few and expands on demand.
const LIVE_COLS = KANBAN_COLS.filter((c) => c.id !== "done");
const DONE_STATUSES: TaskStatus[] = ["merged", "abandoned"];
const DONE_PREVIEW = 3;

function KanbanColumn({ col, tasks, projById, showProject }: {
    col: { id: string; label: string; statuses: TaskStatus[] };
    tasks: TaskVM[];
    projById: Record<string, Project>;
    showProject?: boolean;
}) {
    return (
        <div className="helm-kanban-col" {...verifyAttrs({ unit: "KanbanCol", col: col.id, count: tasks.length })}>
            <div className="helm-col-head">
                <StatusDot status={col.id as TaskStatus} size={7} />
                {col.label}
                <span style={{ color: "var(--text-faint)" }}>{tasks.length}</span>
            </div>
            {tasks.map((t) => <TaskCard key={t.id} task={t} project={projById[t.projectId]} showProject={showProject} />)}
            {!tasks.length && <div style={{ border: "1px dashed var(--border-subtle)", borderRadius: 10, padding: "18px 0", textAlign: "center", color: "var(--text-faint)", fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)" }}>empty</div>}
        </div>
    );
}

// The foldable terminal strip. Collapsed by default; opened it previews DONE_PREVIEW
// cards with a show-more expander so it never balloons the board's height.
function DoneFold({ tasks, projById, showProject }: { tasks: TaskVM[]; projById: Record<string, Project>; showProject?: boolean }) {
    const [open, setOpen] = useState(false);
    const [showAll, setShowAll] = useState(false);
    if (!tasks.length) return null;
    const shown = showAll ? tasks : tasks.slice(0, DONE_PREVIEW);
    const hidden = tasks.length - shown.length;
    return (
        <div className="helm-donefold" {...verifyAttrs({ unit: "DoneFold", count: tasks.length, open, shown: open ? shown.length : 0 })}>
            <button className="helm-donefold-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
                <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} />
                <StatusDot status="merged" size={7} />
                done <span className="helm-donefold-count">{tasks.length}</span>
                {!open && <span className="helm-donefold-hint">merged &amp; abandoned — click to show</span>}
            </button>
            {open && (
                <div className="helm-donefold-body">
                    <div className="helm-donefold-grid">
                        {shown.map((t) => <TaskCard key={t.id} task={t} project={projById[t.projectId]} showProject={showProject} />)}
                    </div>
                    {tasks.length > DONE_PREVIEW && (
                        <button className="helm-col-more" onClick={() => setShowAll((v) => !v)}>
                            {showAll ? "Show fewer" : `Show ${hidden} more`}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

function BoardKanban({ tasks, projById, showProject }: { tasks: TaskVM[]; projById: Record<string, Project>; showProject?: boolean }) {
    const done = sortTasks(tasks.filter((t) => DONE_STATUSES.includes(t.status)));
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <div className="helm-kanban">
                {LIVE_COLS.map((col) => (
                    <KanbanColumn key={col.id} col={col} tasks={sortTasks(tasks.filter((t) => col.statuses.includes(t.status)))} projById={projById} showProject={showProject} />
                ))}
            </div>
            <DoneFold tasks={done} projById={projById} showProject={showProject} />
        </div>
    );
}

/* ---------- dense list ---------- */
function TaskRow({ task, project, showProject }: { task: TaskVM; project?: Project; showProject?: boolean }) {
    const actions = useContext(ActionCtx);
    const cur = task.snap?.currentIteration ?? null;
    const stuck = stuckOf(task);
    const mergePhase = mergePhaseOf(task);
    let detail: ReactNode = null;
    if (mergePhase) detail = <MergeChip phase={mergePhase} />;
    else if (task.status === "running" && cur) detail = <span className="helm-activity" style={{ color: "var(--text-secondary)" }}>{cur.latestActivity || "…"}<span className="helm-live-caret"></span></span>;
    else if (task.status === "needs-human") detail = <span className="helm-activity" style={{ color: "var(--amber-300)" }}>{task.failureReason}</span>;
    else if (task.blocked) detail = <span className="helm-activity" style={{ color: stuck ? "var(--amber-300)" : undefined }}>{stuck ? "stuck — " : "waiting on "}{task.waitingOn.map((p) => p.title).join(", ")}</span>;
    else if (task.status === "merged" && task.diffstat) detail = <span className="helm-activity">{fmtDiffstat(task.diffstat)}</span>;
    else if (task.status === "handed-off") detail = <span className="helm-activity">{task.validating ? "verify & merge running…" : "human at the helm"}</span>;
    else if (task.status === "abandoned") detail = <span className="helm-activity">{task.failureReason || "abandoned"}</span>;

    return (
        <div
            className="helm-row"
            {...verifyAttrs({ unit: "TaskRow", status: task.status, id: task.id, blocked: task.blocked, "merge-phase": mergePhase })}
            style={{ opacity: task.status === "abandoned" ? 0.55 : 1 }} onClick={() => actions.openTask(task.id)}
        >
            <div><StatusChip status={task.blocked ? "blocked" : task.status} /></div>
            <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{task.title}</span>
                {showProject && project && <Mono dim size="var(--text-2xs)">{project.name}{project.jailImage ? " · jail" : ""}</Mono>}
            </div>
            <div style={{ textAlign: "right" }}>
                <Mono dim size="var(--text-2xs)">{attemptOf(task)}/{capOf(project)} · {fmtUsd(task.snap?.totals.costUsd ?? 0)}</Mono>
            </div>
            <div style={{ minWidth: 0, overflow: "hidden" }}>{detail}</div>
            <div className="helm-row-verbs"><VerbBar task={task} compact /></div>
        </div>
    );
}

function BoardList({ tasks, projById, showProject }: { tasks: TaskVM[]; projById: Record<string, Project>; showProject?: boolean }) {
    return (
        <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 10, background: "var(--surface-card)", boxShadow: "var(--elev-card)", overflow: "hidden" }}>
            {sortTasks(tasks).map((t) => <TaskRow key={t.id} task={t} project={projById[t.projectId]} showProject={showProject} />)}
        </div>
    );
}

/* ---------- grid ---------- */
function BoardGrid({ tasks, projById, showProject }: { tasks: TaskVM[]; projById: Record<string, Project>; showProject?: boolean }) {
    return (
        <div className="helm-grid">
            {sortTasks(tasks).map((t) => <TaskCard key={t.id} task={t} project={projById[t.projectId]} showProject={showProject} />)}
        </div>
    );
}

/* ---------- status filter chips ---------- */
const ALL_STATUSES: TaskStatus[] = ["queued", "running", "needs-human", "handed-off", "merged", "abandoned"];
export function StatusFilters({ tasks, active, onToggle }: { tasks: TaskVM[]; active: TaskStatus[]; onToggle: (s: TaskStatus) => void }) {
    const counts: Partial<Record<TaskStatus, number>> = {};
    tasks.forEach((t) => { counts[t.status] = (counts[t.status] ?? 0) + 1; });
    return (
        <div {...verifyAttrs({ unit: "StatusFilters", active: active.join(",") || null })} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {ALL_STATUSES.map((s) => (
                <button key={s} className={"helm-chip" + (active.includes(s) ? " on" : "")} onClick={() => onToggle(s)}>
                    <StatusDot status={s} size={6} /> {s} <span style={{ color: "var(--text-faint)" }}>{counts[s] ?? 0}</span>
                </button>
            ))}
        </div>
    );
}

/* ---------- layout switcher (the design's board-layout tweak, promoted to a real control) ---------- */
export function LayoutSwitch({ layout, onChange }: { layout: BoardLayout; onChange: (l: BoardLayout) => void }) {
    const opts: Array<{ id: BoardLayout; icon: "Columns3" | "List" | "LayoutGrid"; label: string }> = [
        { id: "kanban", icon: "Columns3", label: "Kanban" },
        { id: "list", icon: "List", label: "List" },
        { id: "grid", icon: "LayoutGrid", label: "Grid" },
    ];
    return (
        <div style={{ display: "flex", gap: 2 }}>
            {opts.map((o) => (
                <button key={o.id} className={"helm-iconbtn helm-iconbtn--sm" + (layout === o.id ? " helm-iconbtn--active" : "")}
                    aria-label={o.label} title={o.label} onClick={() => onChange(o.id)}>
                    <Icon name={o.icon} size={14} />
                </button>
            ))}
        </div>
    );
}

/* ---------- board (layout switch + filters) ---------- */
export function Board({ tasks, projects, layout, showProject, planFilter, emptyAction }: {
    tasks: TaskVM[];
    projects: Project[];
    layout: BoardLayout;
    showProject?: boolean;
    planFilter?: string | null;
    emptyAction?: ReactNode;
}) {
    const [statusFilter, setStatusFilter] = useState<TaskStatus[]>([]);
    const projById = Object.fromEntries(projects.map((p) => [p.id, p]));
    let visible = tasks;
    if (planFilter) visible = visible.filter((t) => t.planId === planFilter);
    if (statusFilter.length) visible = visible.filter((t) => statusFilter.includes(t.status));

    const Layout = layout === "list" ? BoardList : layout === "grid" ? BoardGrid : BoardKanban;
    return (
        <div {...verifyAttrs({ unit: "Board", layout, count: visible.length })} style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <StatusFilters
                tasks={planFilter ? tasks.filter((t) => t.planId === planFilter) : tasks} active={statusFilter}
                onToggle={(s) => setStatusFilter((f) => (f.includes(s) ? f.filter((x) => x !== s) : [...f, s]))}
            />
            {visible.length
                ? <Layout tasks={visible} projById={projById} showProject={showProject} />
                : <EmptyState icon="Inbox" line="Nothing here. Queue a task and the scheduler will pick it up." action={emptyAction} />}
        </div>
    );
}
