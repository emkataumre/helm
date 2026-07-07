// src/renderer/components/BoardCard.tsx
import type { Task, WaitingOn } from "../../shared/types";
import { verifyAttrs } from "./verifyAttrs";

// Pure, prop-driven board card. Stamps the task status; a running card shows the live one-liner
// (latest activity from the snapshot's currentIteration) — only while running. The manual-mode Run
// button appears on a queued card ONLY when the scheduler is paused (when running, the scheduler
// auto-starts queued tasks, so a per-card button would be noise). M5: a running OR needs-human card
// offers Drop in + Start fresh (one click from the glance, like M4's Run); needs-human also offers
// Abandon. Drop in --resumes the latest session, so it's DISABLED until one is actually persisted
// (`resumable`) — a killed/not-yet-completed iteration has nothing to resume; Start fresh always works.
// The deliberate hand-back trio lives in TaskDetail (HandbackActions). M9: a queued+blocked card renders
// its waiting-on parents (WAITING = in flight vs STUCK = needs-human/abandoned + Clear dependencies).
export function BoardCard({ task, liveActivity, paused, resumable, blocked, waitingOn, planTitle, onClick, onRun, onDropIn, onStartFresh, onAbandon, onNewTerminal, onClearDeps, onOpenPlan }: {
    task: Task;
    liveActivity?: string;
    paused?: boolean;
    resumable?: boolean;
    blocked?: boolean;
    waitingOn?: WaitingOn[];
    planTitle?: string; // M11: the plan this task was born from (a badge → its detail view); absent = hand-made
    onClick?: () => void;
    onRun?: () => void;
    onDropIn?: () => void;
    onStartFresh?: () => void;
    onAbandon?: () => void;
    onNewTerminal?: () => void;
    onClearDeps?: () => void;
    onOpenPlan?: () => void;
}) {
    const running = task.status === "running";
    const canDropIn = task.status === "running" || task.status === "needs-human";
    // M8: a retained worktree (needs-human/handed-off) can host a free shell cwd'd inside it — one click
    // to open a plain pwsh tab in the worktree (poke around, run git, etc.) without touching the loop.
    const hasRetainedWorktree = (task.status === "needs-human" || task.status === "handed-off") && !!task.worktreePath;
    // Drop in resumes latestSessionId; only offer it once a completed turn has persisted a session.
    const canResume = canDropIn && !!resumable;
    // M9: only a QUEUED card can be "blocked" (a running/merged task isn't waiting to start). STUCK = at least
    // one parent needs-human/abandoned (the human must act) — warning-styled + Clear dependencies; otherwise
    // WAITING (a parent still in flight). The manual Run is hidden while blocked (startNow is gated anyway).
    const waits = task.status === "queued" && blocked ? (waitingOn ?? []) : [];
    const isBlocked = waits.length > 0;
    const stuck = waits.some((w) => w.status === "needs-human" || w.status === "abandoned");
    const waitingTitles = waits.map((w) => w.title).join(", ");
    const click = (fn?: () => void) => (e: { stopPropagation: () => void }) => { e.stopPropagation(); fn?.(); };
    return (
        <div
            className="board-card"
            {...verifyAttrs({ unit: "BoardCard", status: task.status, id: task.id, dropin: canDropIn, resumable: canResume, blocked: isBlocked, "waiting-on": waitingTitles || null, plan: planTitle || null })}
            onClick={onClick}
            style={{ border: "1px solid #ccc", borderRadius: 8, padding: 10, marginBottom: 8, cursor: onClick ? "pointer" : "default" }}
        >
            <div><b>{task.title}</b> {task.diffstat ? <code style={{ fontSize: 11 }}>{task.diffstat}</code> : null}</div>
            {planTitle ? (
                <button
                    onClick={click(onOpenPlan)}
                    title={`Part of plan "${planTitle}" — open its detail`}
                    style={{ marginTop: 4, fontSize: 11, fontFamily: "ui-monospace, monospace", color: "#788C5D", background: "#F0EEE6", border: "1px solid #E3DACC", borderRadius: 6, padding: "1px 6px", cursor: onOpenPlan ? "pointer" : "default" }}
                >plan: {planTitle}</button>
            ) : null}
            {running && liveActivity ? <div style={{ fontSize: 12, color: "#788C5D", marginTop: 4 }}>{liveActivity}</div> : null}
            {task.failureReason ? <div style={{ fontSize: 12, color: "#b00", marginTop: 4 }}>{task.failureReason}</div> : null}
            {isBlocked ? (
                <div style={{ fontSize: 12, marginTop: 4, color: stuck ? "#b00" : "#788C5D" }}>
                    {stuck ? `blocked — resolve first: ${waitingTitles}` : `waiting on: ${waitingTitles}`}
                    {stuck && onClearDeps ? <button onClick={click(onClearDeps)} style={{ marginLeft: 6 }}>Clear dependencies</button> : null}
                </div>
            ) : null}
            {task.status === "queued" && paused && onRun && !isBlocked ? <button onClick={click(onRun)} style={{ marginTop: 6 }}>Run</button> : null}
            {canDropIn || hasRetainedWorktree ? (
                <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {canDropIn && onDropIn ? <button onClick={click(onDropIn)} disabled={!canResume} title={canResume ? "Resume the latest claude session in a terminal" : "No resumable session yet — the current/last iteration hasn't persisted one. Use Start fresh."}>Drop in</button> : null}
                    {canDropIn && onStartFresh ? <button onClick={click(onStartFresh)}>Start fresh</button> : null}
                    {hasRetainedWorktree && onNewTerminal ? <button onClick={click(onNewTerminal)} title="Open a plain shell in this task's worktree">+ terminal</button> : null}
                    {task.status === "needs-human" && onAbandon ? <button onClick={click(onAbandon)}>Abandon</button> : null}
                </div>
            ) : null}
        </div>
    );
}
