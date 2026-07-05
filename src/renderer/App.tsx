import { useEffect, useState, useCallback } from "react";
import type { Project, Task, TaskListItem, TaskStatus, EngineSnapshot, NewProjectInput, SchedulerState, PromoteResponse, PtySession, PtySessionInfo } from "../shared/types";
import { TokenReadout } from "./components/TokenReadout";
import { IterationHistory } from "./components/IterationHistory";
import { ActivityFeed } from "./components/ActivityFeed";
import { ProgressPanel } from "./components/ProgressPanel";
import { BoardCard } from "./components/BoardCard";
import { SchedulerBar } from "./components/SchedulerBar";
import { HandbackActions } from "./components/HandbackActions";
import { PromoteResultPanel } from "./components/PromoteResultPanel";
import { TerminalPane } from "./components/TerminalPane";
import { TerminalTabs } from "./components/TerminalTabs";
import { upsertTab, removeTab, resolveActive } from "./terminalTabs";
import { parseProgress, type ParsedProgress } from "./progress";

// A plain pwsh shell (no claude) is the default program for a free [+ terminal] — the human runs claude
// themselves if they want it. Drop-in tabs still use buildDropinArgv (main-side, in tasks:dropIn).
const FREE_SHELL_ARGV = ["pwsh.exe", "-NoLogo"];

// M5: a 5th lane for handed-off (drop-in) tasks.
const LANES: TaskStatus[] = ["queued", "running", "handed-off", "needs-human", "merged"];
const numOrNull = (s: string): number | null => (s.trim() === "" ? null : Number(s));

// Thin data container: the board (lanes + project filter) and a task-detail view, both driven by
// the prop-driven presentational components. All data crosses window.helm; the components stay pure.
export function App() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [tasks, setTasks] = useState<TaskListItem[]>([]);
    const [filter, setFilter] = useState<string>("");
    const [selected, setSelected] = useState<string | null>(null);
    const [live, setLive] = useState<Record<string, string>>({});
    const [sched, setSched] = useState<SchedulerState | null>(null);
    // M6-③: the last Promote and its result (null until the human clicks Promote on a project).
    const [promote, setPromote] = useState<{ projectId: string; result: PromoteResponse | "loading" } | null>(null);
    // M8 terminal host: a full tab strip over the manager's live sessions (pty:list). `terms` are the open
    // tabs (drop-in returns + free [+ terminal] creates); `activeTerm` is the ONE mounted TerminalPane —
    // switching tabs remounts it (key=id) so it re-attaches and replays the main-side scrollback. `termOpen`
    // collapses the whole host without dropping any session (main-process residency keeps them running).
    const [terms, setTerms] = useState<PtySessionInfo[]>([]);
    const [activeTerm, setActiveTerm] = useState<string | null>(null);
    const [termOpen, setTermOpen] = useState(true);

    // Open/focus a session as a tab (a Drop-in return or a [+ terminal] create). upsertTab is idempotent,
    // so re-opening a live session just re-focuses it.
    const showTerm = useCallback((s: PtySession) => { setTerms((ts) => upsertTab(ts, s)); setActiveTerm(s.id); setTermOpen(true); }, []);
    // Close a tab = kill the session — the ONLY renderer-initiated kill (an explicit user action). Unmount
    // (Hide / tab-switch / window-hide) NEVER kills. The exit event then prunes the tab; drop it optimistically.
    const closeTerm = useCallback((id: string) => { window.helm.ptyKill(id); setTerms((ts) => removeTab(ts, id)); }, []);
    // A plain shell in a project's repo (cwd = repoPath) or a task's retained worktree (cwd = worktreePath).
    const newProjectTerminal = useCallback((p: Project) => {
        window.helm.ptyCreate({ cwd: p.repoPath, argv: FREE_SHELL_ARGV, kind: "free", title: `${p.name} — shell`, projectId: p.id }).then(showTerm);
    }, [showTerm]);
    const newTaskTerminal = useCallback((t: Task) => {
        if (!t.worktreePath) return;
        window.helm.ptyCreate({ cwd: t.worktreePath, argv: FREE_SHELL_ARGV, kind: "free", title: `${t.title} — shell`, taskId: t.id, projectId: t.projectId }).then(showTerm);
    }, [showTerm]);

    const refresh = useCallback(async () => {
        setProjects(await window.helm.listProjects());
        setTasks(await window.helm.listTasks());
    }, []);
    const refreshSched = useCallback(async () => { setSched(await window.helm.getSchedulerState()); }, []);

    useEffect(() => {
        refresh(); refreshSched();
        window.helm.ptyList().then(setTerms); // repopulate the tab strip on (re)mount — sessions live in main
        window.helm.onTasksChanged(() => { refresh(); refreshSched(); });
        window.helm.onSnapshotChanged(async (taskId) => {
            const snap = await window.helm.getVerifyState(taskId);
            if (snap?.currentIteration) setLive((m) => ({ ...m, [taskId]: snap.currentIteration!.latestActivity }));
        });
        // A session that exits (claude quit + pwsh closed, killed, or the process died) → prune its tab.
        const unsubExit = window.helm.onPtyExit((id) => setTerms((ts) => removeTab(ts, id)));
        const id = setInterval(refreshSched, 1000); // keep the per-project running counts live
        return () => { clearInterval(id); unsubExit(); };
    }, [refresh, refreshSched]);

    // Keep the focused tab valid: whenever the tab list changes, a closed/exited active tab hands focus to
    // a neighbour (resolveActive) instead of blanking the pane; an empty list drops focus to null.
    useEffect(() => { setActiveTerm((a) => resolveActive(terms, a)); }, [terms]);

    const togglePaused = async (paused: boolean) => { await window.helm.setSchedulerPaused(paused); refreshSched(); };
    const paused = sched?.paused ?? false;

    // Run one project's batch Promote: show a loading panel, then the PromoteResponse (a thrown engine
    // error — e.g. a mid-promote git failure — is surfaced as a recheck-failed so the human sees why).
    const doPromote = async (projectId: string) => {
        setPromote({ projectId, result: "loading" });
        try { setPromote({ projectId, result: await window.helm.promote(projectId) }); }
        catch (e) { setPromote({ projectId, result: { outcome: "recheck-failed", output: e instanceof Error ? e.message : String(e) } }); }
    };

    const selectedTask = selected ? tasks.find((t) => t.id === selected) : undefined;
    const shown = tasks.filter((t) => !filter || t.projectId === filter);
    const abandoned = shown.filter((t) => t.status === "abandoned");
    const queuedByProject = tasks.reduce<Record<string, number>>((m, t) => { if (t.status === "queued") m[t.projectId] = (m[t.projectId] ?? 0) + 1; return m; }, {});
    const names = Object.fromEntries(projects.map((p) => [p.id, p.name]));

    return (
        <div style={{ fontFamily: "system-ui", padding: 20, display: "grid", gap: 20, maxWidth: 1120, margin: "0 auto" }}>
            <h1 style={{ fontFamily: "ui-serif, Georgia, serif" }}>Helm</h1>

            {selectedTask ? (
                <TaskDetail task={selectedTask} onClose={() => setSelected(null)} onAction={refresh} />
            ) : (
                <>
                    <RegisterProjectForm onDone={refresh} />
                    <ProjectConfigForm projects={projects} onDone={refresh} />
                    <NewTaskForm projects={projects} tasks={tasks} onDone={refresh} />

                    {sched ? <SchedulerBar state={sched} queuedByProject={queuedByProject} names={names} onSetPaused={togglePaused} /> : null}

                    {projects.length > 0 ? (
                        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                            <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, textTransform: "uppercase", color: "#788C5D" }}>Promote (integration → target)</span>
                            {projects.map((p) => (
                                <button key={p.id} onClick={() => doPromote(p.id)} disabled={promote?.projectId === p.id && promote.result === "loading"}>
                                    {p.name} ({p.promotionMode})
                                </button>
                            ))}
                        </div>
                    ) : null}
                    {promote ? <PromoteResultPanel projectName={names[promote.projectId] ?? promote.projectId} result={promote.result} /> : null}

                    {projects.length > 0 ? (
                        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                            <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, textTransform: "uppercase", color: "#788C5D" }}>Terminals (free shell in repo)</span>
                            {projects.map((p) => (
                                <button key={p.id} onClick={() => newProjectTerminal(p)} title={`Open a pwsh shell in ${p.repoPath}`}>+ {p.name}</button>
                            ))}
                        </div>
                    ) : null}

                    <div>
                        <label>Project filter:{" "}
                            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                                <option value="">all projects</option>
                                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                        </label>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
                        {LANES.map((lane) => (
                            <div key={lane}>
                                <h3 style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, textTransform: "uppercase", color: "#788C5D" }}>{lane}</h3>
                                {shown.filter((t) => t.status === lane).map((t) => (
                                    <BoardCard
                                        key={t.id} task={t} liveActivity={live[t.id]} paused={paused} resumable={t.resumable}
                                        blocked={t.blocked} waitingOn={t.waitingOn}
                                        onClick={() => setSelected(t.id)}
                                        onRun={() => { window.helm.startNow(t.id); }}
                                        onDropIn={() => { window.helm.dropIn(t.id).then((s) => { refresh(); if (s) showTerm(s); }); }}
                                        onStartFresh={() => { window.helm.dropIn(t.id, true).then((s) => { refresh(); if (s) showTerm(s); }); }}
                                        onAbandon={() => { window.helm.abandon(t.id).then(refresh); }}
                                        onNewTerminal={() => newTaskTerminal(t)}
                                        onClearDeps={() => { window.helm.setDependsOn(t.id, []).then(refresh); }}
                                    />
                                ))}
                            </div>
                        ))}
                    </div>

                    {abandoned.length > 0 ? (
                        <details>
                            <summary>abandoned ({abandoned.length})</summary>
                            {abandoned.map((t) => <BoardCard key={t.id} task={t} onClick={() => setSelected(t.id)} />)}
                        </details>
                    ) : null}
                </>
            )}

            {/* M8 terminal host: a docked, constrained tab strip + ONE mounted pane. Reserve space so the
                fixed host never covers the board's tail. */}
            {terms.length > 0 ? <TerminalHost terms={terms} activeId={activeTerm} open={termOpen} onFocus={(id) => { setActiveTerm(id); setTermOpen(true); }} onClose={closeTerm} onToggleOpen={() => setTermOpen((v) => !v)} /> : null}
        </div>
    );
}

// The docked terminal host: a tab strip over every live session + the single active TerminalPane (keyed by
// id, so a tab switch remounts it → re-attach + scrollback replay, and a hidden tab's 0×0 element never
// mis-fits). Collapsed (Hide) it keeps every session running (main-process residency); Show re-attaches.
function TerminalHost({ terms, activeId, open, onFocus, onClose, onToggleOpen }: {
    terms: PtySessionInfo[];
    activeId: string | null;
    open: boolean;
    onFocus: (id: string) => void;
    onClose: (id: string) => void;
    onToggleOpen: () => void;
}) {
    const active = terms.find((t) => t.id === activeId) ?? null;
    return (
        <>
            <div style={{ height: open ? 372 : 60 }} />
            <div
                data-verify-unit="TerminalHost" data-verify-open={String(open)} data-verify-count={terms.length}
                style={{ position: "fixed", left: 0, right: 0, bottom: 0, height: open ? 360 : 44, background: "#1e1e1c", borderTop: "1.5px solid #3D3D3A", display: "flex", flexDirection: "column", zIndex: 50 }}
            >
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 12px", borderBottom: open ? "1px solid #2a2a28" : "none", color: "#FAF9F5" }}>
                    <span style={{ textTransform: "uppercase", color: "#D97757", fontFamily: "ui-monospace, monospace", fontSize: 11, letterSpacing: 0.5, flexShrink: 0 }}>terminals</span>
                    <TerminalTabs sessions={terms} activeId={activeId} onFocus={onFocus} onClose={onClose} />
                    <button style={{ flexShrink: 0 }} onClick={onToggleOpen}>{open ? "Hide" : "Show"}</button>
                </div>
                {open && active ? (
                    <div style={{ flex: 1, minHeight: 0, padding: 8, boxSizing: "border-box", maxWidth: 1120, width: "100%", margin: "0 auto" }}>
                        <TerminalPane key={active.id} session={active} />
                    </div>
                ) : null}
            </div>
        </>
    );
}

function TaskDetail({ task, onClose, onAction }: { task: Task; onClose: () => void; onAction: () => void }) {
    const taskId = task.id;
    const [snap, setSnap] = useState<EngineSnapshot | null>(null);
    const [progress, setProgress] = useState<ParsedProgress | null>(null);
    const [showProgress, setShowProgress] = useState(false);

    useEffect(() => {
        let active = true;
        const poll = async () => { const s = await window.helm.getVerifyState(taskId); if (active) setSnap(s); };
        poll();
        const id = setInterval(poll, 1000); // poll the live snapshot while the detail is open
        return () => { active = false; clearInterval(id); };
    }, [taskId]);

    const toggleProgress = async () => {
        if (!showProgress) {
            const md = await window.helm.getProgress(taskId);
            setProgress(md == null ? null : parseProgress(md));
        }
        setShowProgress((v) => !v);
    };

    // M5 hand-back trio (handed-off only). Driven off task.status (always present) so it renders even
    // before the snapshot loads; each action calls the engine then refreshes the board.
    const act = (fn: (id: string) => Promise<void>) => async () => { await fn(taskId); onAction(); };
    const handback = (
        <HandbackActions
            status={task.status}
            launchError={task.failureReason}
            onResume={act((id) => window.helm.resumeTask(id))}
            onVerifyAndMerge={act((id) => window.helm.verifyAndMerge(id))}
            onAbandon={act((id) => window.helm.abandon(id))}
        />
    );

    if (!snap) {
        return (
            <div style={{ display: "grid", gap: 14 }}>
                <div><button onClick={onClose}>← board</button></div>
                <h2 style={{ fontFamily: "ui-serif, Georgia, serif", margin: 0 }}>{task.id} — <code>{task.status}</code></h2>
                {handback}
                <p>Loading…</p>
            </div>
        );
    }

    const lastFailing = [...snap.iterations].reverse().find((i) => i.verdict === "failed" || i.verdict === "hang");
    return (
        <div style={{ display: "grid", gap: 14 }}>
            <div><button onClick={onClose}>← board</button></div>
            <h2 style={{ fontFamily: "ui-serif, Georgia, serif", margin: 0 }}>{task.id} — <code>{task.status}</code></h2>
            {handback}
            {snap.terminalReason ? <div style={{ color: "#b00" }}>{snap.terminalReason}</div> : null}
            {snap.currentIteration ? (
                <div style={{ color: "#788C5D", fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
                    iteration {snap.currentIteration.index} · {snap.currentIteration.phase} · {snap.currentIteration.latestActivity || "…"}
                </div>
            ) : null}

            <TokenReadout totals={snap.totals} iterations={snap.iterations} />

            <section><h3>Iterations</h3><IterationHistory iterations={snap.iterations} /></section>
            <section><h3>Activity feed</h3><ActivityFeed feed={snap.feed} /></section>

            {lastFailing ? (
                <section>
                    <h3>Last failing gate (iteration {lastFailing.index})</h3>
                    <div style={{ fontSize: 12, color: "#888" }}>verdict: {lastFailing.verdict} · commit {lastFailing.commitSha ?? "—"}</div>
                </section>
            ) : null}

            <section>
                <h3>progress.md <button onClick={toggleProgress}>{showProgress ? "hide" : "show"}</button></h3>
                {showProgress ? <ProgressPanel progress={progress} /> : null}
            </section>
        </div>
    );
}

function RegisterProjectForm({ onDone }: { onDone: () => void }) {
    const [f, setF] = useState({ name: "", repoPath: "", targetBranch: "main", checkCommand: "", setupCommand: "", iterationCap: "", noProgressK: "", stallTimeoutMin: "", model: "", concurrencyCap: "", terminalCommand: "", autoModeEnvironment: "", promotionMode: "pr" });
    const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

    const detect = async () => {
        if (!f.repoPath) return;
        const d = await window.helm.detectProject(f.repoPath);
        setF((s) => ({ ...s, targetBranch: d.targetBranch ?? s.targetBranch, checkCommand: d.checkCommand ?? s.checkCommand, setupCommand: d.setupCommand ?? s.setupCommand }));
    };
    const submit = async () => {
        const input: NewProjectInput = {
            name: f.name, repoPath: f.repoPath, targetBranch: f.targetBranch, checkCommand: f.checkCommand,
            setupCommand: f.setupCommand || null, model: f.model || null,
            iterationCap: numOrNull(f.iterationCap), noProgressK: numOrNull(f.noProgressK), stallTimeoutMin: numOrNull(f.stallTimeoutMin),
            concurrencyCap: numOrNull(f.concurrencyCap), terminalCommand: f.terminalCommand || null,
            autoModeEnvironment: f.autoModeEnvironment || null,
            promotionMode: f.promotionMode as "pr" | "direct" | "strict",
        };
        await window.helm.registerProject(input);
        onDone();
    };

    const input = (k: keyof typeof f, ph: string) => <input key={k} placeholder={ph} value={f[k]} onChange={set(k)} style={{ display: "block", margin: "4px 0", width: 480 }} />;
    return (
        <details>
            <summary>Register project</summary>
            <div style={{ paddingTop: 8 }}>
                {input("name", "name")}
                {input("repoPath", "repoPath")}
                <button onClick={detect} style={{ margin: "4px 0" }}>Auto-detect from repo</button>
                {input("targetBranch", "targetBranch (auto-detected)")}
                {input("checkCommand", "checkCommand — mandatory")}
                {input("setupCommand", "setupCommand (optional)")}
                {input("iterationCap", "iterationCap (blank = default 8)")}
                {input("noProgressK", "noProgressK (blank = default 2)")}
                {input("stallTimeoutMin", "stallTimeoutMin (blank = default 40)")}
                {input("concurrencyCap", "concurrencyCap (blank = default 3)")}
                {input("model", "model (blank = CLI default)")}
                {input("terminalCommand", 'terminalCommand (blank = in-app terminal tab; set a template to launch externally, e.g. wt.exe -d "{worktree}" pwsh -NoExit -Command "claude {resume}")')}
                {input("autoModeEnvironment", 'autoModeEnvironment (blank = ["$defaults"] — trusts repo + origin)')}
                <label style={{ display: "block", margin: "4px 0" }}>promotionMode{" "}
                    <select value={f.promotionMode} onChange={set("promotionMode")}>
                        <option value="pr">pr — push integration, hand a gh pr create command</option>
                        <option value="direct">direct — push the validated branch, hand a raw-sha push</option>
                        <option value="strict">strict — push nothing, hand the full local sequence</option>
                    </select>
                </label>
                <button disabled={!f.name || !f.repoPath || !f.checkCommand} onClick={submit}>Register</button>
            </div>
        </details>
    );
}

function ProjectConfigForm({ projects, onDone }: { projects: Project[]; onDone: () => void }) {
    const [id, setId] = useState("");
    const selected = projects.find((p) => p.id === id);
    const [f, setF] = useState({ setupCommand: "", iterationCap: "", noProgressK: "", stallTimeoutMin: "", model: "", concurrencyCap: "", terminalCommand: "", autoModeEnvironment: "", promotionMode: "pr" });

    useEffect(() => {
        if (!selected) return;
        setF({
            setupCommand: selected.setupCommand ?? "",
            iterationCap: selected.iterationCap?.toString() ?? "",
            noProgressK: selected.noProgressK?.toString() ?? "",
            stallTimeoutMin: selected.stallTimeoutMin?.toString() ?? "",
            model: selected.model ?? "",
            concurrencyCap: selected.concurrencyCap?.toString() ?? "",
            terminalCommand: selected.terminalCommand ?? "",
            autoModeEnvironment: selected.autoModeEnvironment ?? "",
            promotionMode: selected.promotionMode,
        });
    }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

    const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
    const save = async () => {
        await window.helm.updateProject(id, {
            setupCommand: f.setupCommand || null, model: f.model || null,
            iterationCap: numOrNull(f.iterationCap), noProgressK: numOrNull(f.noProgressK), stallTimeoutMin: numOrNull(f.stallTimeoutMin),
            concurrencyCap: numOrNull(f.concurrencyCap), terminalCommand: f.terminalCommand || null,
            autoModeEnvironment: f.autoModeEnvironment || null,
            promotionMode: f.promotionMode as "pr" | "direct" | "strict",
        });
        onDone();
    };
    // Delete the whole project (+ its tasks/iterations, cascaded in the DB). Guarded by a confirm since it's
    // irreversible; on success clear the selection and refresh the board.
    const remove = async () => {
        if (!selected) return;
        if (!window.confirm(`Delete project "${selected.name}" and all its tasks? This cannot be undone.`)) return;
        await window.helm.deleteProject(selected.id);
        setId("");
        onDone();
    };
    const input = (k: keyof typeof f, ph: string) => <input placeholder={ph} value={f[k]} onChange={set(k)} style={{ display: "block", margin: "4px 0", width: 480 }} />;
    return (
        <details>
            <summary>Edit project config</summary>
            <div style={{ paddingTop: 8 }}>
                <select value={id} onChange={(e) => setId(e.target.value)}>
                    <option value="">— project —</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {selected ? (
                    <>
                        {input("setupCommand", "setupCommand")}
                        {input("iterationCap", "iterationCap")}
                        {input("noProgressK", "noProgressK")}
                        {input("stallTimeoutMin", "stallTimeoutMin")}
                        {input("concurrencyCap", "concurrencyCap")}
                        {input("model", "model")}
                        {input("terminalCommand", "terminalCommand (blank = in-app tab; else external template)")}
                        {input("autoModeEnvironment", 'autoModeEnvironment (blank = ["$defaults"])')}
                        <label style={{ display: "block", margin: "4px 0" }}>promotionMode{" "}
                            <select value={f.promotionMode} onChange={set("promotionMode")}>
                                <option value="pr">pr</option>
                                <option value="direct">direct</option>
                                <option value="strict">strict</option>
                            </select>
                        </label>
                        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                            <button onClick={save}>Save config</button>
                            <button onClick={remove} style={{ color: "#D97757" }}>Delete project</button>
                        </div>
                    </>
                ) : null}
            </div>
        </details>
    );
}

function NewTaskForm({ projects, tasks, onDone }: { projects: Project[]; tasks: TaskListItem[]; onDone: () => void }) {
    const [f, setF] = useState({ projectId: "", title: "", intent: "", acceptance: "", scopeHint: "" });
    // M9: hand-made dependency chains. Candidate parents are the selected project's non-terminal tasks
    // (merged/abandoned are pointless to wait on). Reset the picks when the project changes so a chosen id
    // can't leak across projects.
    const [deps, setDeps] = useState<string[]>([]);
    const candidates = tasks.filter((t) => t.projectId === f.projectId && t.status !== "merged" && t.status !== "abandoned");
    return (
        <details>
            <summary>New task</summary>
            <div style={{ paddingTop: 8 }}>
                <select value={f.projectId} onChange={(e) => { setF({ ...f, projectId: e.target.value }); setDeps([]); }}>
                    <option value="">— project —</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input placeholder="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} style={{ display: "block", margin: "4px 0", width: 480 }} />
                <textarea placeholder="intent (what to build)" value={f.intent} onChange={(e) => setF({ ...f, intent: e.target.value })} style={{ display: "block", margin: "4px 0", width: 480, height: 60 }} />
                <textarea placeholder="acceptance commands, one per line" value={f.acceptance} onChange={(e) => setF({ ...f, acceptance: e.target.value })} style={{ display: "block", margin: "4px 0", width: 480, height: 60 }} />
                <input placeholder="scopeHint (optional, e.g. src/widgets/**)" value={f.scopeHint} onChange={(e) => setF({ ...f, scopeHint: e.target.value })} style={{ display: "block", margin: "4px 0", width: 480 }} />
                {candidates.length > 0 ? (
                    <label style={{ display: "block", margin: "4px 0", fontSize: 13 }}>depends on (optional — waits for these to merge first)
                        <select multiple value={deps} onChange={(e) => setDeps(Array.from(e.target.selectedOptions, (o) => o.value))} style={{ display: "block", width: 480, minHeight: 60, margin: "4px 0" }}>
                            {candidates.map((t) => <option key={t.id} value={t.id}>{t.title} ({t.status})</option>)}
                        </select>
                    </label>
                ) : null}
                <button
                    disabled={!f.projectId || !f.title || !f.intent || !f.acceptance.trim()}
                    onClick={async () => {
                        await window.helm.createTask({
                            projectId: f.projectId, title: f.title, intent: f.intent,
                            acceptance: f.acceptance.split("\n").map((s) => s.trim()).filter(Boolean),
                            scopeHint: f.scopeHint.trim() || null,
                            dependsOn: deps,
                        });
                        // Clear the form after a successful create — otherwise the just-made task lingers in
                        // the depends-on picker (and the fields stay populated for an accidental re-submit).
                        setF({ projectId: "", title: "", intent: "", acceptance: "", scopeHint: "" });
                        setDeps([]);
                        onDone();
                    }}
                >Create</button>
            </div>
        </details>
    );
}
