import { useEffect, useState, useCallback } from "react";
import type { Project, Task, TaskStatus, EngineSnapshot, NewProjectInput, SchedulerState } from "../shared/types";
import { TokenReadout } from "./components/TokenReadout";
import { IterationHistory } from "./components/IterationHistory";
import { ActivityFeed } from "./components/ActivityFeed";
import { ProgressPanel } from "./components/ProgressPanel";
import { BoardCard } from "./components/BoardCard";
import { SchedulerBar } from "./components/SchedulerBar";
import { HandbackActions } from "./components/HandbackActions";
import { parseProgress, type ParsedProgress } from "./progress";

// M5: a 5th lane for handed-off (drop-in) tasks.
const LANES: TaskStatus[] = ["queued", "running", "handed-off", "needs-human", "merged"];
const numOrNull = (s: string): number | null => (s.trim() === "" ? null : Number(s));

// Thin data container: the board (lanes + project filter) and a task-detail view, both driven by
// the prop-driven presentational components. All data crosses window.helm; the components stay pure.
export function App() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [filter, setFilter] = useState<string>("");
    const [selected, setSelected] = useState<string | null>(null);
    const [live, setLive] = useState<Record<string, string>>({});
    const [sched, setSched] = useState<SchedulerState | null>(null);

    const refresh = useCallback(async () => {
        setProjects(await window.helm.listProjects());
        setTasks(await window.helm.listTasks());
    }, []);
    const refreshSched = useCallback(async () => { setSched(await window.helm.getSchedulerState()); }, []);

    useEffect(() => {
        refresh(); refreshSched();
        window.helm.onTasksChanged(() => { refresh(); refreshSched(); });
        window.helm.onSnapshotChanged(async (taskId) => {
            const snap = await window.helm.getVerifyState(taskId);
            if (snap?.currentIteration) setLive((m) => ({ ...m, [taskId]: snap.currentIteration!.latestActivity }));
        });
        const id = setInterval(refreshSched, 1000); // keep the per-project running counts live
        return () => clearInterval(id);
    }, [refresh, refreshSched]);

    const togglePaused = async (paused: boolean) => { await window.helm.setSchedulerPaused(paused); refreshSched(); };
    const paused = sched?.paused ?? false;

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
                    <NewTaskForm projects={projects} onDone={refresh} />

                    {sched ? <SchedulerBar state={sched} queuedByProject={queuedByProject} names={names} onSetPaused={togglePaused} /> : null}

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
                                        key={t.id} task={t} liveActivity={live[t.id]} paused={paused}
                                        onClick={() => setSelected(t.id)}
                                        onRun={() => { window.helm.startNow(t.id); }}
                                        onDropIn={() => { window.helm.dropIn(t.id).then(refresh); }}
                                        onStartFresh={() => { window.helm.dropIn(t.id, true).then(refresh); }}
                                        onAbandon={() => { window.helm.abandon(t.id).then(refresh); }}
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
        </div>
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
    const [f, setF] = useState({ name: "", repoPath: "", targetBranch: "main", checkCommand: "", setupCommand: "", iterationCap: "", noProgressK: "", stallTimeoutMin: "", model: "", concurrencyCap: "", terminalCommand: "" });
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
                {input("terminalCommand", 'terminalCommand (blank = wt.exe -d "{worktree}" claude {resume})')}
                <button disabled={!f.name || !f.repoPath || !f.checkCommand} onClick={submit}>Register</button>
            </div>
        </details>
    );
}

function ProjectConfigForm({ projects, onDone }: { projects: Project[]; onDone: () => void }) {
    const [id, setId] = useState("");
    const selected = projects.find((p) => p.id === id);
    const [f, setF] = useState({ setupCommand: "", iterationCap: "", noProgressK: "", stallTimeoutMin: "", model: "", concurrencyCap: "", terminalCommand: "" });

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
        });
    }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

    const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
    const save = async () => {
        await window.helm.updateProject(id, {
            setupCommand: f.setupCommand || null, model: f.model || null,
            iterationCap: numOrNull(f.iterationCap), noProgressK: numOrNull(f.noProgressK), stallTimeoutMin: numOrNull(f.stallTimeoutMin),
            concurrencyCap: numOrNull(f.concurrencyCap), terminalCommand: f.terminalCommand || null,
        });
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
                        {input("terminalCommand", "terminalCommand")}
                        <button onClick={save}>Save config</button>
                    </>
                ) : null}
            </div>
        </details>
    );
}

function NewTaskForm({ projects, onDone }: { projects: Project[]; onDone: () => void }) {
    const [f, setF] = useState({ projectId: "", title: "", intent: "", acceptance: "", scopeHint: "" });
    return (
        <details>
            <summary>New task</summary>
            <div style={{ paddingTop: 8 }}>
                <select value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}>
                    <option value="">— project —</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input placeholder="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} style={{ display: "block", margin: "4px 0", width: 480 }} />
                <textarea placeholder="intent (what to build)" value={f.intent} onChange={(e) => setF({ ...f, intent: e.target.value })} style={{ display: "block", margin: "4px 0", width: 480, height: 60 }} />
                <textarea placeholder="acceptance commands, one per line" value={f.acceptance} onChange={(e) => setF({ ...f, acceptance: e.target.value })} style={{ display: "block", margin: "4px 0", width: 480, height: 60 }} />
                <input placeholder="scopeHint (optional, e.g. src/widgets/**)" value={f.scopeHint} onChange={(e) => setF({ ...f, scopeHint: e.target.value })} style={{ display: "block", margin: "4px 0", width: 480 }} />
                <button
                    disabled={!f.projectId || !f.title || !f.intent || !f.acceptance.trim()}
                    onClick={async () => {
                        await window.helm.createTask({
                            projectId: f.projectId, title: f.title, intent: f.intent,
                            acceptance: f.acceptance.split("\n").map((s) => s.trim()).filter(Boolean),
                            scopeHint: f.scopeHint.trim() || null,
                        });
                        onDone();
                    }}
                >Create</button>
            </div>
        </details>
    );
}
