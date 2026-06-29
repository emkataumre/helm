import { useEffect, useState, useCallback } from "react";
import type { Project, Task, TaskStatus, EngineSnapshot, NewProjectInput } from "../shared/types";
import { TokenReadout } from "./components/TokenReadout";
import { IterationHistory } from "./components/IterationHistory";
import { ActivityFeed } from "./components/ActivityFeed";
import { ProgressPanel } from "./components/ProgressPanel";
import { BoardCard } from "./components/BoardCard";
import { parseProgress, type ParsedProgress } from "./progress";

const LANES: TaskStatus[] = ["queued", "running", "needs-human", "merged"];
const numOrNull = (s: string): number | null => (s.trim() === "" ? null : Number(s));

// Thin data container: the board (lanes + project filter) and a task-detail view, both driven by
// the prop-driven presentational components. All data crosses window.helm; the components stay pure.
export function App() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [filter, setFilter] = useState<string>("");
    const [selected, setSelected] = useState<string | null>(null);
    const [live, setLive] = useState<Record<string, string>>({});

    const refresh = useCallback(async () => {
        setProjects(await window.helm.listProjects());
        setTasks(await window.helm.listTasks());
    }, []);

    useEffect(() => {
        refresh();
        window.helm.onTasksChanged(refresh);
        window.helm.onSnapshotChanged(async (taskId) => {
            const snap = await window.helm.getVerifyState(taskId);
            if (snap?.currentIteration) setLive((m) => ({ ...m, [taskId]: snap.currentIteration!.latestActivity }));
        });
    }, [refresh]);

    const shown = tasks.filter((t) => !filter || t.projectId === filter);
    const abandoned = shown.filter((t) => t.status === "abandoned");

    return (
        <div style={{ fontFamily: "system-ui", padding: 20, display: "grid", gap: 20, maxWidth: 1120, margin: "0 auto" }}>
            <h1 style={{ fontFamily: "ui-serif, Georgia, serif" }}>Helm</h1>

            {selected ? (
                <TaskDetail taskId={selected} onClose={() => setSelected(null)} />
            ) : (
                <>
                    <RegisterProjectForm onDone={refresh} />
                    <ProjectConfigForm projects={projects} onDone={refresh} />
                    <NewTaskForm projects={projects} onDone={refresh} />

                    <div>
                        <label>Project filter:{" "}
                            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                                <option value="">all projects</option>
                                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                        </label>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
                        {LANES.map((lane) => (
                            <div key={lane}>
                                <h3 style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, textTransform: "uppercase", color: "#788C5D" }}>{lane}</h3>
                                {shown.filter((t) => t.status === lane).map((t) => (
                                    <BoardCard key={t.id} task={t} liveActivity={live[t.id]} onClick={() => setSelected(t.id)} onRun={() => { window.helm.startNow(t.id); }} />
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

function TaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }) {
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

    if (!snap) return <div><button onClick={onClose}>← board</button><p>Loading…</p></div>;

    const lastFailing = [...snap.iterations].reverse().find((i) => i.verdict === "failed" || i.verdict === "hang");
    return (
        <div style={{ display: "grid", gap: 14 }}>
            <div><button onClick={onClose}>← board</button></div>
            <h2 style={{ fontFamily: "ui-serif, Georgia, serif", margin: 0 }}>{snap.taskId} — <code>{snap.status}</code></h2>
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
    const [f, setF] = useState({ name: "", repoPath: "", targetBranch: "main", checkCommand: "", setupCommand: "", iterationCap: "", noProgressK: "", stallTimeoutMin: "", model: "" });
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
                {input("model", "model (blank = CLI default)")}
                <button disabled={!f.name || !f.repoPath || !f.checkCommand} onClick={submit}>Register</button>
            </div>
        </details>
    );
}

function ProjectConfigForm({ projects, onDone }: { projects: Project[]; onDone: () => void }) {
    const [id, setId] = useState("");
    const selected = projects.find((p) => p.id === id);
    const [f, setF] = useState({ setupCommand: "", iterationCap: "", noProgressK: "", stallTimeoutMin: "", model: "" });

    useEffect(() => {
        if (!selected) return;
        setF({
            setupCommand: selected.setupCommand ?? "",
            iterationCap: selected.iterationCap?.toString() ?? "",
            noProgressK: selected.noProgressK?.toString() ?? "",
            stallTimeoutMin: selected.stallTimeoutMin?.toString() ?? "",
            model: selected.model ?? "",
        });
    }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

    const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
    const save = async () => {
        await window.helm.updateProject(id, {
            setupCommand: f.setupCommand || null, model: f.model || null,
            iterationCap: numOrNull(f.iterationCap), noProgressK: numOrNull(f.noProgressK), stallTimeoutMin: numOrNull(f.stallTimeoutMin),
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
                        {input("model", "model")}
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
