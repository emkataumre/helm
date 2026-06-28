import { useEffect, useState } from "react";
import type { Project, Task } from "../shared/types";

export function App() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    const refresh = async () => { setProjects(await window.helm.listProjects()); setTasks(await window.helm.listTasks()); };
    useEffect(() => { refresh(); window.helm.onTasksChanged(refresh); }, []);

    return (
        <div style={{ fontFamily: "system-ui", padding: 20, display: "grid", gap: 24, maxWidth: 900, margin: "0 auto" }}>
            <h1>Helm</h1>
            <ProjectForm onDone={refresh} />
            <TaskForm projects={projects} onDone={refresh} />
            <section>
                <h2>Tasks</h2>
                {tasks.map((t) => (
                    <div key={t.id} style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, marginBottom: 8 }}>
                        <b>{t.title}</b> — <code>{t.status}</code> {t.diffstat ? `(${t.diffstat})` : ""}
                        {t.failureReason ? <div style={{ color: "#b00" }}>{t.failureReason}</div> : null}
                        {t.status === "queued" ? <button onClick={() => window.helm.runTask(t.id)}>Run</button> : null}
                    </div>
                ))}
            </section>
        </div>
    );
}

function ProjectForm({ onDone }: { onDone: () => void }) {
    const [f, setF] = useState({ name: "", repoPath: "", targetBranch: "main", checkCommand: "" });
    return (
        <section>
            <h2>Register project</h2>
            {(["name", "repoPath", "targetBranch", "checkCommand"] as const).map((k) => (
                <input key={k} placeholder={k} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} style={{ display: "block", margin: "4px 0", width: 480 }} />
            ))}
            <button onClick={async () => { await window.helm.registerProject(f); onDone(); }}>Register</button>
        </section>
    );
}

function TaskForm({ projects, onDone }: { projects: Project[]; onDone: () => void }) {
    const [f, setF] = useState({ projectId: "", title: "", intent: "", acceptance: "" });
    return (
        <section>
            <h2>New task</h2>
            <select value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}>
                <option value="">— project —</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input placeholder="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} style={{ display: "block", margin: "4px 0", width: 480 }} />
            <textarea placeholder="intent (what to build)" value={f.intent} onChange={(e) => setF({ ...f, intent: e.target.value })} style={{ display: "block", margin: "4px 0", width: 480, height: 60 }} />
            <textarea placeholder="acceptance commands, one per line" value={f.acceptance} onChange={(e) => setF({ ...f, acceptance: e.target.value })} style={{ display: "block", margin: "4px 0", width: 480, height: 60 }} />
            <button
                disabled={!f.projectId || !f.title || !f.intent || !f.acceptance.trim()}
                onClick={async () => {
                    await window.helm.createTask({
                        projectId: f.projectId, title: f.title, intent: f.intent,
                        acceptance: f.acceptance.split("\n").map((s) => s.trim()).filter(Boolean),
                    });
                    onDone();
                }}
            >Create</button>
        </section>
    );
}
