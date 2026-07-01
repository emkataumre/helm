// src/renderer/components/BoardCard.tsx
import type { Task } from "../../shared/types";
import { verifyAttrs } from "./verifyAttrs";

// Pure, prop-driven board card. Stamps the task status; a running card shows the live one-liner
// (latest activity from the snapshot's currentIteration) — only while running. The manual-mode Run
// button appears on a queued card ONLY when the scheduler is paused (when running, the scheduler
// auto-starts queued tasks, so a per-card button would be noise). M5: a running OR needs-human card
// offers Drop in + Start fresh (one click from the glance, like M4's Run); needs-human also offers
// Abandon. Drop in --resumes the latest session, so it's DISABLED until one is actually persisted
// (`resumable`) — a killed/not-yet-completed iteration has nothing to resume; Start fresh always works.
// The deliberate hand-back trio lives in TaskDetail (HandbackActions).
export function BoardCard({ task, liveActivity, paused, resumable, onClick, onRun, onDropIn, onStartFresh, onAbandon }: {
    task: Task;
    liveActivity?: string;
    paused?: boolean;
    resumable?: boolean;
    onClick?: () => void;
    onRun?: () => void;
    onDropIn?: () => void;
    onStartFresh?: () => void;
    onAbandon?: () => void;
}) {
    const running = task.status === "running";
    const canDropIn = task.status === "running" || task.status === "needs-human";
    // Drop in resumes latestSessionId; only offer it once a completed turn has persisted a session.
    const canResume = canDropIn && !!resumable;
    const click = (fn?: () => void) => (e: { stopPropagation: () => void }) => { e.stopPropagation(); fn?.(); };
    return (
        <div
            className="board-card"
            {...verifyAttrs({ unit: "BoardCard", status: task.status, id: task.id, dropin: canDropIn, resumable: canResume })}
            onClick={onClick}
            style={{ border: "1px solid #ccc", borderRadius: 8, padding: 10, marginBottom: 8, cursor: onClick ? "pointer" : "default" }}
        >
            <div><b>{task.title}</b> {task.diffstat ? <code style={{ fontSize: 11 }}>{task.diffstat}</code> : null}</div>
            {running && liveActivity ? <div style={{ fontSize: 12, color: "#788C5D", marginTop: 4 }}>{liveActivity}</div> : null}
            {task.failureReason ? <div style={{ fontSize: 12, color: "#b00", marginTop: 4 }}>{task.failureReason}</div> : null}
            {task.status === "queued" && paused && onRun ? <button onClick={click(onRun)} style={{ marginTop: 6 }}>Run</button> : null}
            {canDropIn ? (
                <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {onDropIn ? <button onClick={click(onDropIn)} disabled={!canResume} title={canResume ? "Resume the latest claude session in a terminal" : "No resumable session yet — the current/last iteration hasn't persisted one. Use Start fresh."}>Drop in</button> : null}
                    {onStartFresh ? <button onClick={click(onStartFresh)}>Start fresh</button> : null}
                    {task.status === "needs-human" && onAbandon ? <button onClick={click(onAbandon)}>Abandon</button> : null}
                </div>
            ) : null}
        </div>
    );
}
