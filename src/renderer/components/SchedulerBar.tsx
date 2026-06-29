// src/renderer/components/SchedulerBar.tsx
import type { SchedulerState } from "../../shared/types";
import { verifyAttrs } from "./verifyAttrs";

// Pure, prop-driven scheduler bar: a global pause/resume toggle plus a per-project "running/cap · N
// queued" readout. Stamps a data-verify-* contract whose within-cap flag asserts every project's
// running ≤ cap — the renderer-side mirror of the engine's running-count-within-cap invariant (the
// probe drives running > cap and expects within-cap="false"). No window.helm here; the container
// wires the toggle and supplies the queued counts + names from data it already holds.
export function SchedulerBar({ state, queuedByProject, names, onSetPaused }: {
    state: SchedulerState;
    queuedByProject?: Record<string, number>;
    names?: Record<string, string>;
    onSetPaused: (paused: boolean) => void;
}) {
    const withinCap = state.perProject.every((p) => p.running <= p.cap);
    return (
        <div
            className="scheduler-bar"
            {...verifyAttrs({ unit: "SchedulerBar", paused: state.paused, projects: state.perProject.length, "within-cap": withinCap })}
            style={{ border: "1.5px solid #E3DACC", borderRadius: 12, padding: "10px 14px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}
        >
            <button onClick={() => onSetPaused(!state.paused)}>
                {state.paused ? "Resume (auto-fleet)" : "Pause (manual mode)"}
            </button>
            <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#788C5D" }}>
                {state.paused ? "paused — start queued tasks by hand" : "running — auto-starting queued tasks"}
            </span>
            <div style={{ display: "flex", gap: 14, marginLeft: "auto", flexWrap: "wrap" }}>
                {state.perProject.map((p) => (
                    <span
                        key={p.projectId}
                        {...verifyAttrs({ unit: "SchedulerSlot", project: p.projectId, running: p.running, cap: p.cap })}
                        style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: p.running > p.cap ? "#D97757" : "#3D3D3A" }}
                    >
                        {names?.[p.projectId] ?? p.projectId}: {p.running}/{p.cap} · {queuedByProject?.[p.projectId] ?? 0} queued
                    </span>
                ))}
            </div>
        </div>
    );
}
