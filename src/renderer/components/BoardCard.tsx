// src/renderer/components/BoardCard.tsx
import type { Task } from "../../shared/types";
import { verifyAttrs } from "./verifyAttrs";

// Pure, prop-driven board card. Stamps the task status; a running card shows the live one-liner
// (latest activity from the snapshot's currentIteration) — only while running.
export function BoardCard({ task, liveActivity, onClick, onRun }: {
    task: Task;
    liveActivity?: string;
    onClick?: () => void;
    onRun?: () => void;
}) {
    const running = task.status === "running";
    return (
        <div
            className="board-card"
            {...verifyAttrs({ unit: "BoardCard", status: task.status, id: task.id })}
            onClick={onClick}
            style={{ border: "1px solid #ccc", borderRadius: 8, padding: 10, marginBottom: 8, cursor: onClick ? "pointer" : "default" }}
        >
            <div><b>{task.title}</b> {task.diffstat ? <code style={{ fontSize: 11 }}>{task.diffstat}</code> : null}</div>
            {running && liveActivity ? <div style={{ fontSize: 12, color: "#788C5D", marginTop: 4 }}>{liveActivity}</div> : null}
            {task.failureReason ? <div style={{ fontSize: 12, color: "#b00", marginTop: 4 }}>{task.failureReason}</div> : null}
            {task.status === "queued" && onRun ? <button onClick={(e) => { e.stopPropagation(); onRun(); }} style={{ marginTop: 6 }}>Run</button> : null}
        </div>
    );
}
